/**
 * Codec for Mac: one window on the live site (CODEC_URL overrides it for local testing). The site does the work;
 * this shell adds what a browser tab can't: a Dock icon with the unread badge, macOS notifications, a menu bar icon,
 * and staying signed in and syncing after the window is closed, so calls still ring. Cmd+Q quits for real.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, session, shell } = require('electron');
const policy = require('./policy.cjs');

const APP_URL = policy.appUrlFrom(process.env);
const ASSETS = path.join(__dirname, '..', 'assets');

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let ssoActive = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
}

function start() {
  lockDownPermissions();
  buildMenu();
  createTray();
  createWindow();
  app.on('activate', showWindow); // Dock icon click
  app.on('before-quit', () => {
    quitting = true;
  });
}

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    title: 'Codec',
    backgroundColor: '#313338',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep syncing at full speed while hidden: rings and notifications arrive with the window closed.
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win && win.show());

  // Closing the window only hides it (Mac convention); the app keeps running in the Dock and menu bar.
  win.on('close', (event) => {
    if (!win) return;
    saveBounds(win.getBounds());
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    win = null;
  });

  const contents = win.webContents;
  contents.on('will-navigate', (event, url) => {
    const decision = policy.decideNavigation(url, { appUrl: APP_URL, ssoActive });
    ssoActive = decision.ssoActive;
    if (decision.action === 'allow') return;
    event.preventDefault();
    if (decision.action === 'external') void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    const where = policy.decideWindowOpen(url, APP_URL);
    if (where === 'external') void shell.openExternal(url);
    if (where !== 'in-app') return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 640,
        height: 760,
        backgroundColor: '#313338',
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      },
    };
  });
  // In-app popups (an image, the sign-in check): links inside them go to the default browser.
  contents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  void win.loadURL(APP_URL);
}

function showWindow() {
  if (!win) createWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Messages from the page (preload.cjs). Only the main window on the app's own origin is listened to. */
function fromApp(event) {
  return !!win && event.sender === win.webContents && policy.isAppUrl(event.senderFrame ? event.senderFrame.url : '', APP_URL);
}

ipcMain.on('codec:badge', (event, count) => {
  if (!fromApp(event)) return;
  const value = policy.badgeValue(count);
  app.setBadgeCount(value);
  if (tray) tray.setTitle(value > 0 ? String(value) : '');
});
ipcMain.on('codec:focus', (event) => {
  if (fromApp(event)) showWindow();
});
ipcMain.on('codec:attention', (event) => {
  if (!fromApp(event) || !app.dock) return;
  if (!win || !win.isFocused()) app.dock.bounce('critical');
});

function lockDownPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(policy.permissionAllowed(permission, details.requestingUrl || contents.getURL(), APP_URL));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => policy.permissionAllowed(permission, requestingOrigin, APP_URL));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Codec');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Codec', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Codec', role: 'quit' },
    ]),
  );
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        {
          // Way out if a sign-in page gets stuck: back to Codec's start page.
          label: 'Back to Codec',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            ssoActive = false;
            showWindow();
            if (win) void win.loadURL(APP_URL);
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function boundsFile() {
  return path.join(app.getPath('userData'), 'window.json');
}

function loadBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    // Size only: a saved position can sit on a display that is no longer attached.
    if ([saved.width, saved.height].every((n) => Number.isInteger(n) && n >= 480)) return { width: saved.width, height: saved.height };
  } catch {
    // first launch
  }
  return { width: 1280, height: 820 };
}

function saveBounds(bounds) {
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(bounds));
  } catch {
    // not worth failing a close over
  }
}
