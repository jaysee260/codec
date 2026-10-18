/**
 * Authenticated media and login methods (PR #1): the media service worker, safe full-size links,
 * SSO sign-in and the login screen adapting to what the homeserver offers.
 *
 * The local homeserver runs with `enable_authenticated_media: false`, but `/_matrix/client/v1/media/*`
 * always requires the access token, so v1 URLs that load prove the worker attaches it.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { loginAs, SESSION_STORAGE_KEY } from './fixtures/auth.ts';
import { asUser } from './fixtures/matrix-api.ts';
import { HS_URL, roomId } from './fixtures/seed.ts';
import { messageList, openChannel } from './fixtures/ui.ts';

const PNG = new Uint8Array(readFileSync('e2e/fixtures/test-image.png'));
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.__svgRan = true</script></svg>',
);

/** bob posts an m.image to #dev; alice opens #dev and gets the image element. */
async function postImageAndOpen(page: Page, bytes: Uint8Array, mimetype: string, name: string) {
  const bob = await asUser('bob');
  const mxc = await bob.upload(bytes, mimetype, name);
  await bob.sendEvent(roomId('dev'), 'm.room.message', {
    msgtype: 'm.image',
    body: name,
    url: mxc,
    info: { w: 10, h: 10, mimetype, size: bytes.length },
  });
  await loginAs(page, 'alice');
  await openChannel(page, roomId('dev'));
  const image = messageList(page).getByTestId('message-image').last();
  await expect(image).toBeVisible({ timeout: 15_000 });
  return image;
}

/** Every homeserver image on the page loaded, and through authenticated v1 URLs. */
async function expectAuthedImagesLoaded(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.$$eval('img[src*="/_matrix/"]', (els) =>
        (els as HTMLImageElement[]).map((e) => ({ v1: e.src.includes('/_matrix/client/v1/media/'), ok: e.naturalWidth > 0 })),
      ),
    )
    .toEqual(expect.arrayContaining([{ v1: true, ok: true }]));
  const bad = await page.$$eval('img[src*="/_matrix/"]', (els) =>
    (els as HTMLImageElement[]).filter((e) => !e.src.includes('/_matrix/client/v1/media/')).map((e) => e.src),
  );
  expect(bad, 'no unauthenticated media URLs').toEqual([]);
}

test.describe('authenticated media', () => {
  test('images and avatars load through v1 URLs with the token', async ({ page }) => {
    const image = await postImageAndOpen(page, PNG, 'image/png', 'auth-media.png');
    await expect.poll(() => image.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expectAuthedImagesLoaded(page);
  });

  test('after a hard reload the worker controls the page again', async ({ page, context }) => {
    await postImageAndOpen(page, PNG, 'image/png', 'auth-media-reload.png');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.reload', { ignoreCache: true });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expectAuthedImagesLoaded(page);
  });

  test('a full-size PNG opens in a new tab as a blob', async ({ page }) => {
    const image = await postImageAndOpen(page, PNG, 'image/png', 'auth-media-open.png');
    const [tab] = await Promise.all([page.waitForEvent('popup'), image.click()]);
    await tab.waitForURL(/^blob:/, { timeout: 10_000 });
  });

  test('a non-raster "image" (SVG) is downloaded, never opened in our origin', async ({ page }) => {
    const image = await postImageAndOpen(page, SVG, 'image/svg+xml', 'evil.svg');
    const download = page.waitForEvent('download');
    await image.click({ force: true }); // the SVG thumbnail may not render; the link still must be safe
    expect((await download).suggestedFilename()).toBe('evil.svg');
    for (const p of page.context().pages()) {
      expect(p.url(), 'no tab may show the SVG').not.toMatch(/^blob:/);
      expect(await p.evaluate(() => (window as { __svgRan?: boolean }).__svgRan ?? false)).toBe(false);
    }
  });
});

test.describe('login methods', () => {
  test('an SSO-only server shows the provider button and no password form or Register', async ({ page }) => {
    await page.route('**/_matrix/client/v3/login', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: { flows: [{ type: 'm.login.sso', identity_providers: [{ id: 'oidc-keycloak', name: 'Keycloak' }] }] },
          })
        : route.continue(),
    );
    await page.goto('/');
    const sso = page.getByTestId('login-sso');
    await expect(sso).toHaveText('Continue with Keycloak');
    await expect(page.getByTestId('login-username')).toHaveCount(0);
    await expect(page.getByTestId('login-register-toggle')).toHaveCount(0);
    const [req] = await Promise.all([page.waitForRequest(/\/login\/sso\/redirect\/oidc-keycloak/), sso.click()]);
    expect(new URL(req.url()).searchParams.get('redirectUrl')).toMatch(/^http:\/\/localhost:\d+\/$/);
  });

  test('Register is hidden when the server has registration closed', async ({ page }) => {
    await page.route('**/_matrix/client/v3/register', (route) =>
      route.fulfill({ status: 403, json: { errcode: 'M_FORBIDDEN', error: 'Registration has been disabled' } }),
    );
    await page.goto('/');
    await expect(page.getByTestId('login-username')).toBeVisible();
    await expect(page.getByTestId('login-register-toggle')).toHaveCount(0);
  });

  test('returning from SSO with a login token signs in and strips the token', async ({ page, browser }) => {
    const alice = await asUser('alice');
    const res = await fetch(`${HS_URL}/_matrix/client/v1/login/get_token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    test.skip(!res.ok, 'homeserver has login_via_existing_session off (needed to mint a login token)');
    const { login_token } = (await res.json()) as { login_token: string };
    // Closed in `finally`: a leaked context keeps a logged-in alice syncing (and running crypto) for the rest of
    // the run, which slowed every later login past the 20 s shell timeout (BUG-20).
    const context = await browser.newContext();
    try {
      const fresh = await context.newPage();
      await fresh.goto(`/?loginToken=${encodeURIComponent(login_token)}`);
      await expect(fresh.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
      expect(fresh.url()).not.toContain('loginToken');
    } finally {
      await context.close();
    }
    void page;
  });

  test('an expired login token keeps a stored session, or explains itself without one', async ({ page }) => {
    await page.goto('/?loginToken=bogus');
    await expect(page.getByTestId('login-error')).toHaveText('That sign-in expired, please try again');

    await loginAs(page, 'alice');
    await page.goto('/?loginToken=bogus');
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate((key) => !!localStorage.getItem(key), SESSION_STORAGE_KEY)).toBe(true);
  });
});
