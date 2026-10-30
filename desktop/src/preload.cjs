/**
 * The page's bridge to the Mac shell: `window.codecDesktop` (typed in src/lib/desktop/model.ts). Codec checks for it
 * to switch on the Dock badge and notifications; nothing else from Electron or Node reaches the page.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codecDesktop', {
  platform: process.platform,
  setBadge: (count) => ipcRenderer.send('codec:badge', count),
  focus: () => ipcRenderer.send('codec:focus'),
  attention: () => ipcRenderer.send('codec:attention'),
});
