#!/usr/bin/env node
/**
 * Principal's Phase 2 verification script (not part of the QA suite). Drives the dev server with Playwright's
 * Pixel 7 descriptor, logs in as alice, checks the phone shell and screenshots it, then (optionally) round-trips
 * a voice event through the real `getVoiceMessage` via the dev-only `window.__matrixPoc` hooks.
 *
 *   npm run dev -- --port 5183                       # in another terminal (dev build: __matrixPoc is installed)
 *   node scripts/verify-phone-shell.mjs              # screenshots -> docs/screenshots/phase2-shell-phone*.png
 *   node scripts/verify-phone-shell.mjs --voice out.json   # out.json from send-voice-sample.mjs --json
 *
 * Environment: E2E_BASE_URL (http://localhost:5183).
 */
import { chromium, devices } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5183';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const args = process.argv.slice(2);
const voiceJson = args.includes('--voice') ? args[args.indexOf('--voice') + 1] : undefined;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- phone (Pixel 7)
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await phone.newPage();
  const errors = [];
  const notFound = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/msc4143|rtc\/transports/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  // "Failed to load resource: 404" console lines carry no URL; record the URLs here. The SDK's MatrixRTC probe
  // (/_matrix/client/unstable/org.matrix.msc4143/rtc/transports) 404s once per startClient and is expected.
  page.on('response', (r) => {
    if (r.status() === 404) notFound.push(r.url());
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-form').waitFor({ timeout: 15_000 });
  const viewport = page.viewportSize();
  check('login form renders on Pixel 7', true, `${viewport.width}x${viewport.height}`);
  check('viewport meta', (await page.locator('meta[name=viewport]').getAttribute('content')) === 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');

  // Advanced homeserver field: collapsed by default, persists to localStorage, normalises.
  await page.getByTestId('login-advanced-toggle').click();
  const hs = page.getByTestId('login-hs-url');
  await hs.waitFor();
  check('login-hs-url default', (await hs.inputValue()) === 'http://localhost:8008', await hs.inputValue());
  await hs.fill('192.168.1.50:8009/');
  await hs.blur();
  const stored = await page.evaluate(() => localStorage.getItem('matrix-poc.hsUrl'));
  check('login-hs-url normalised + persisted', (await hs.inputValue()) === 'http://192.168.1.50:8009' && stored === 'http://192.168.1.50:8009', `${await hs.inputValue()} / ${stored}`);
  await page.getByTestId('login-hs-url-reset').click();
  check('login-hs-url reset', (await page.evaluate(() => localStorage.getItem('matrix-poc.hsUrl'))) === null && (await hs.inputValue()) === 'http://localhost:8008');
  await page.screenshot({ path: path.join(SHOTS, 'phase2-login-phone.png') });

  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  const shell = page.getByTestId('app-shell');
  await shell.waitFor({ timeout: 30_000 });
  await page.getByTestId('composer').waitFor({ timeout: 15_000 });
  await page.getByTestId('message-list').locator('[data-testid^="message-$"]').first().waitFor({ timeout: 20_000 });

  check('data-layout=phone', (await shell.getAttribute('data-layout')) === 'phone');
  const navDrawer = page.getByTestId('nav-drawer');
  check('nav-drawer closed', (await navDrawer.getAttribute('data-open')) === 'false');
  check('space-rail hidden', !(await page.getByTestId('space-rail').isVisible()));
  check('channel-sidebar hidden', !(await page.getByTestId('channel-sidebar').isVisible()));
  check('drawer-backdrop hidden', !(await page.getByTestId('drawer-backdrop').isVisible()));
  const listBox = await page.getByTestId('message-list').boundingBox();
  check('message-list >= 400px wide', !!listBox && listBox.width >= 400, `${Math.round(listBox?.width ?? 0)}px`);
  const metrics = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    bodyH: document.body.scrollHeight,
    innerH: window.innerHeight,
    shellH: document.querySelector('[data-testid=app-shell]').getBoundingClientRect().height,
    tapTarget: getComputedStyle(document.documentElement).getPropertyValue('--tap-target').trim(),
    safeBottom: getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom').trim(),
    touchAction: getComputedStyle(document.querySelector('[data-testid=app-shell]')).touchAction,
    overscroll: getComputedStyle(document.documentElement).overscrollBehavior,
    layoutAttr: document.documentElement.dataset.layout,
  }));
  check('no horizontal page scroll', metrics.scrollW <= metrics.innerW, `${metrics.scrollW} <= ${metrics.innerW}`);
  check('no vertical page scroll', metrics.bodyH <= metrics.innerH, `${metrics.bodyH} <= ${metrics.innerH}`);
  check('app-shell height == innerHeight', Math.abs(metrics.shellH - metrics.innerH) <= 1, `${metrics.shellH} vs ${metrics.innerH}`);
  check('--tap-target 44px', metrics.tapTarget === '44px', metrics.tapTarget);
  check('touch-action manipulation', metrics.touchAction === 'manipulation', metrics.touchAction);
  check('overscroll-behavior none', /none/.test(metrics.overscroll), metrics.overscroll);
  check('html[data-layout=phone]', metrics.layoutAttr === 'phone');
  await page.screenshot({ path: path.join(SHOTS, 'phase2-shell-phone.png') });
  console.log('saved docs/screenshots/phase2-shell-phone.png');

  // Open the nav drawer through the store (Dev A's header-menu button is not in yet).
  await page.evaluate(() => window.__matrixPoc.layout.getState().openNav());
  await page.waitForTimeout(400);
  check('nav-drawer opens', (await navDrawer.getAttribute('data-open')) === 'true');
  check('space-rail visible in drawer', await page.getByTestId('space-rail').isVisible());
  check('channel-sidebar visible in drawer', await page.getByTestId('channel-sidebar').isVisible());
  check('current-user in drawer', await page.getByTestId('current-user').isVisible());
  check('drawer-backdrop visible', await page.getByTestId('drawer-backdrop').isVisible());
  const drawerBox = await navDrawer.boundingBox();
  const ratio = drawerBox ? drawerBox.width / viewport.width : 0;
  check('drawer width 75-90%', ratio >= 0.75 && ratio <= 0.9, `${(ratio * 100).toFixed(0)}%`);
  await page.screenshot({ path: path.join(SHOTS, 'phase2-shell-phone-nav.png') });
  console.log('saved docs/screenshots/phase2-shell-phone-nav.png');

  // Space switch keeps the drawer open; picking a room closes it.
  const gaming = page.getByTestId('space-rail').locator('[data-name="Gaming"]');
  if (await gaming.count()) {
    await gaming.click();
    await page.waitForTimeout(300);
    check('space switch keeps drawer open', (await navDrawer.getAttribute('data-open')) === 'true');
    const lobby = page.getByTestId('channel-list').locator('[data-name="lobby"]');
    await lobby.waitFor({ timeout: 5000 });
    await lobby.click();
    await page.waitForTimeout(400);
    check('selectRoom closes drawer', (await navDrawer.getAttribute('data-open')) === 'false');
    await page.getByTestId('channel-header-name').filter({ hasText: 'lobby' }).waitFor({ timeout: 5000 });
  }
  // Backdrop closes.
  await page.evaluate(() => window.__matrixPoc.layout.getState().openNav());
  await page.waitForTimeout(300);
  await page.getByTestId('drawer-backdrop').click({ position: { x: viewport.width - 10, y: viewport.height / 2 } });
  await page.waitForTimeout(300);
  check('backdrop tap closes drawer', (await navDrawer.getAttribute('data-open')) === 'false');

  // Member drawer container.
  await page.evaluate(() => window.__matrixPoc.layout.getState().openMembers());
  await page.waitForTimeout(300);
  check('member-drawer opens', (await page.getByTestId('member-drawer').getAttribute('data-open')) === 'true');
  await page.evaluate(() => window.__matrixPoc.layout.getState().openNav());
  await page.waitForTimeout(100);
  check('one drawer at a time', (await page.getByTestId('member-drawer').getAttribute('data-open')) === 'false' && (await navDrawer.getAttribute('data-open')) === 'true');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes drawers', (await navDrawer.getAttribute('data-open')) === 'false');

  // Resize to desktop and back without reload.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(300);
  check('resize -> desktop layout', (await shell.getAttribute('data-layout')) === 'desktop' && (await page.getByTestId('nav-drawer').count()) === 0);
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(300);
  check('resize -> phone layout', (await shell.getAttribute('data-layout')) === 'phone');

  // Voice round trip through the real parser.
  if (voiceJson && existsSync(voiceJson)) {
    const sample = JSON.parse(readFileSync(voiceJson, 'utf8'));
    await page.evaluate((roomId) => window.__matrixPoc.rooms.getState().selectRoom(roomId), sample.roomId);
    await page.getByTestId('message-list').locator(`[data-testid="message-${sample.eventId}"]`).waitFor({ timeout: 15_000 }).catch(() => undefined);
    const parsed = await page.evaluate(({ roomId, eventId }) => {
      const client = window.__matrixPoc.getClient();
      const ev = client?.getRoom(roomId)?.findEventById(eventId);
      if (!ev) return { error: 'event not in the live timeline' };
      const body = window.__matrixPoc.getDisplayBody(ev);
      return { voice: window.__matrixPoc.getVoiceMessage(ev), msgtype: body.msgtype, text: body.text, hasVoiceOnBody: !!body.voice };
    }, sample);
    const v = parsed.voice;
    check(
      'getVoiceMessage round trip',
      !!v && v.isVoice && v.durationMs === sample.durationMs && v.waveform.length === sample.waveformSamples && v.mimetype === sample.mimetype && v.mxc === sample.mxc && v.url.startsWith('http') && parsed.hasVoiceOnBody,
      parsed.error ?? `${v?.mimetype} ${v?.durationMs}ms ${v?.waveform?.length} samples url=${v?.url}`,
    );
    const playable = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const blob = await res.blob();
      const a = await window.__matrixPoc.analyzeAudio(blob);
      return { status: res.status, size: blob.size, decoded: a.decoded, durationMs: a.durationMs, peak: Math.max(...a.waveform) };
    }, v?.url ?? '');
    check('voice media decodes in the browser', playable.status === 200 && playable.decoded && Math.abs(playable.durationMs - sample.durationMs) < 50 && playable.peak > 0, JSON.stringify(playable));
    await page.screenshot({ path: path.join(SHOTS, 'phase2-voice-event-phone.png') });
  }

  const mime = await page.evaluate(() => window.__matrixPoc.pickRecordingMimeType());
  check('pickRecordingMimeType (Chromium)', mime === 'audio/webm;codecs=opus', String(mime));

  if (errors.length) {
    console.log('browser errors:');
    for (const e of errors) console.log('  ' + e);
  }
  if (notFound.length) console.log('404 responses (msc4143 rtc/transports is the expected SDK probe):\n  ' + notFound.join('\n  '));
  check('no page errors', errors.filter((e) => e.startsWith('pageerror')).length === 0);
  check('no unexpected 404s', notFound.every((u) => /msc4143|rtc\/transports/.test(u)), notFound.filter((u) => !/msc4143/.test(u)).join(', '));
  await phone.close();

  // ---------------------------------------------------------------- desktop regression
  const desktop = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } });
  const dpage = await desktop.newPage();
  await dpage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await dpage.getByTestId('login-username').fill('alice');
  await dpage.getByTestId('login-password').fill('password123');
  await dpage.getByTestId('login-submit').click();
  await dpage.getByTestId('app-shell').waitFor({ timeout: 30_000 });
  await dpage.getByTestId('space-rail').waitFor();
  check('desktop data-layout', (await dpage.getByTestId('app-shell').getAttribute('data-layout')) === 'desktop');
  check('desktop has no drawers', (await dpage.getByTestId('nav-drawer').count()) === 0 && (await dpage.getByTestId('member-drawer').count()) === 0 && (await dpage.getByTestId('drawer-backdrop').count()) === 0);
  check('desktop member-list visible', await dpage.getByTestId('member-list').isVisible());
  await desktop.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
