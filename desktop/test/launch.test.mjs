/**
 * Mac app launch check: starts the real Electron shell against local stand-in pages (no homeserver needed) and checks
 * the behaviour the policy unit tests can't: the bridge reaches the page, the Dock badge call arrives, links leave
 * for the browser, the SSO sign-in walks through other hosts and comes back, and closing the window only hides it.
 *
 *   npm run test:launch      (needs the Electron binary: `npm install` without --ignore-scripts)
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Serve `pages[pathname]` (a function of the request URL) on a free port; returns the origin. */
function serve(pages) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const page = pages[url.pathname];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
    res.end(page ? page(url) : 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

describe('Codec for Mac shell', () => {
  let app;
  let win;
  const servers = [];

  before(async () => {
    // Three origins like production: Codec, the homeserver, Keycloak.
    const codec = await serve({ '/': () => '<title>Codec</title><a id="ext" href="https://example.com/article">article</a>' });
    const idp = await serve({ '/auth': (u) => `<p>sign in</p><script>setTimeout(() => { location.href = ${JSON.stringify(u.searchParams.get('back'))}; }, 50)</script>` });
    const hs = await serve({
      '/_matrix/client/v3/login/sso/redirect': (u) => {
        const back = `${u.searchParams.get('redirectUrl')}?loginToken=t0k`;
        return `<script>location.href = ${JSON.stringify(`${idp.origin}/auth?back=${encodeURIComponent(back)}`)}</script>`;
      },
    });
    servers.push(codec, idp, hs);
    app = await electron.launch({
      cwd: ROOT,
      args: [ROOT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      env: { ...process.env, CODEC_URL: `${codec.origin}/` },
    });
    await app.evaluate(({ app: electronApp, shell }) => {
      globalThis.__opened = [];
      globalThis.__badges = [];
      shell.openExternal = async (url) => void globalThis.__opened.push(url);
      electronApp.setBadgeCount = (n) => (globalThis.__badges.push(n), true);
    });
    win = await app.firstWindow();
    await win.waitForLoadState();
    win.hsOrigin = hs.origin;
    win.codecOrigin = codec.origin;
  });

  after(async () => {
    await app?.close();
    for (const { server } of servers) server.close();
  });

  test('the page sees window.codecDesktop and its badge calls reach the Dock', async () => {
    assert.equal(await win.evaluate(() => typeof window.codecDesktop?.setBadge), 'function');
    await win.evaluate(() => window.codecDesktop.setBadge(3));
    await win.waitForTimeout(200);
    assert.deepEqual(await app.evaluate(() => globalThis.__badges), [3]);
  });

  test('notifications are allowed for Codec', async () => {
    assert.equal(await win.evaluate(() => Notification.requestPermission()), 'granted');
  });

  test('links open in the default browser and Codec stays put', async () => {
    const before = win.url();
    await win.evaluate(() => document.getElementById('ext').click()); // a cancelled navigation: no Playwright click wait
    await win.evaluate(() => window.open('https://example.com/popup', '_blank'));
    await win.waitForTimeout(300);
    assert.equal(win.url(), before);
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), ['https://example.com/article', 'https://example.com/popup']);
  });

  test('SSO sign-in goes through the homeserver and Keycloak in the window and lands back with a login token', async () => {
    const back = `${win.codecOrigin}/`;
    await win.evaluate((url) => (location.href = url), `${win.hsOrigin}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(back)}`);
    await win.waitForURL(/loginToken=t0k/, { timeout: 10_000 });
    assert.ok(win.url().startsWith(back));
    assert.equal((await app.evaluate(() => globalThis.__opened)).length, 2, 'no sign-in page went to the browser');
  });

  test('closing the window hides it; the app keeps running', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await win.waitForTimeout(200);
    const state = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
    assert.deepEqual(state, [false]);
  });
});
