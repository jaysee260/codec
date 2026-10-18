/**
 * Phase 5 QA-25: crypto boot, persistence, wipe (AC-E1), decrypting the timeline (AC-E2), encrypted by default
 * (AC-E6), key import (AC-E7-3). Desktop, serial, at most two contexts (alice in `page`, bob in a second context).
 *
 * Which criteria need what:
 *  - **sample script + key import** (`scripts/send-encrypted-sample.mjs`, `seed/e2ee-keys.json`): AC-E2-2, AC-E2-4,
 *    AC-E7-3. The script's device sends *before* alice's device exists, so alice gets a genuine historical UTD.
 *  - **live second context** (bob-B): AC-E2-1, AC-E2-5, AC-E2-7 (bob closes before alice logs in).
 *  - **API only**: AC-E1-4 (`DELETE /devices`), AC-E6-6 (bob turns a room encrypted).
 * Every criterion asserts the core half through the dev hook and the wire through the API; the UI halves owned by
 * Dev A / Dev B are `uiHalf` / `requireUi` and say "waiting on Dev A/B" until their testids are in `src/`.
 * alice's account cross-signing state is NOT touched here (that is e2ee-security.spec.ts, on throwaway users).
 *
 * Part boot (AC-E1, layout regression, AC-E6) of the former `e2ee-core.spec.ts`, split (issue #2, docs/PERF_PLAN.md) so the two
 * halves can run on different Playwright workers; tests moved verbatim. Other half: `e2ee-core-timeline.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { resolveRoom, uniqueName, userId } from './fixtures/seed.ts';
import { composer, openChannel, openHome, openSpace, row, rowByText, settledEventId, typeAndSend, channelItem, byName } from './fixtures/ui.ts';
import {
  createRoom,
  deleteDevice,
  devicesOf,
  expectEncryptedOnWire,
  freshUser,
  joinRoom,
  publishedDeviceKeys,
  rawEvent,
  sendStateEvent,
  setRoomEncryption,
  stateContent,
} from './fixtures/e2ee-api.ts';
import {
  e2eeAfterEach,
  cryptoDbNames,
  dbNames,
  expectCryptoWiped,
  loginWith,
  requireUi,
  storedSession,
  traceLoadingStages,
  uiHalf,
  waitForStatus,
} from './fixtures/e2ee.ts';
import { annotate } from './fixtures/state.ts';

// Sequential (workers: 1) but not `serial`: one red criterion must not hide the rest.
test.describe.configure({ timeout: 150_000 });

const R = { vault: '', general: '', acme: '', gaming: '' };
let alice: ApiUser;
let bob: ApiUser;
const created: { roomId: string; parent?: string }[] = [];

test.beforeAll(async () => {
  R.vault = await resolveRoom('vault');
  R.general = await resolveRoom('general');
  R.acme = await resolveRoom('acme-hq');
  R.gaming = await resolveRoom('gaming');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
});

test.afterAll(async () => {
  for (const { roomId, parent } of created) {
    try {
      if (!parent) {
        // A space made in the UI comes with its own #general: leave it too, or alice keeps an
        // orphan encrypted "general" in Other Rooms after every run.
        const kids = await alice.hierarchy(roomId).catch(() => ({ rooms: [] as { room_id: string }[] }));
        for (const kid of kids.rooms) {
          if (kid.room_id === roomId) continue;
          await alice.leaveRoom(kid.room_id).catch(() => undefined);
          await alice.forgetRoom(kid.room_id).catch(() => undefined);
        }
      }
      if (parent) await alice.sendStateEvent(parent, 'm.space.child', roomId, {});
      await alice.leaveRoom(roomId);
      await alice.forgetRoom(roomId);
    } catch {
      /* best effort */
    }
  }
});

async function openVault(page: Page): Promise<void> {
  // A fresh login can land on Home (DMs): pick Acme HQ first.
  if (!(await channelItem(page, R.vault).isVisible().catch(() => false))) await openSpace(page, R.acme);
  await openChannel(page, R.vault);
}

const uniq = (label: string): string => `[qa] ${label} ${Date.now().toString(36)}`;

/* ================================================================== AC-E1 boot, persistence, wipe */

test.describe('AC-E1 crypto boot', () => {
  test('AC-E1-1 + AC-E1-5 (dev half): crypto stage shown, engine ready, device keys uploaded, wasm served', async ({ page }) => {
    const trace = await traceLoadingStages(page);
    const wasm: number[] = [];
    const errors: string[] = [];
    page.on('response', (r) => {
      if (/\.wasm(\?|$)/.test(r.url())) wasm.push(r.status());
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const shellMs = await loginWith(page, 'alice');
    expect(await trace.stages(), 'app-loading[data-stage="crypto"] at some point').toContain('crypto');
    if (shellMs > 10_000) annotate('slow-boot', `app-shell ${shellMs} ms after submit (AC-SH-2 budget 10 s)`);
    expect(shellMs, 'shell within the AC-SH-2 budget (10 s, +5 s slack for the shared box)').toBeLessThan(15_000);

    const s = await waitForStatus(page);
    expect(s.cryptoReady).toBe(true);
    expect(s.cryptoError).toBeNull();
    const session = await storedSession(page);
    expect(s.status.deviceId).toBe(session!.deviceId);

    const keys = await page.evaluate(async () => {
      const k = await (window as any).__matrixPoc.security.getCryptoApi().getOwnDeviceKeys();
      return { ed25519: k.ed25519, curve25519: k.curve25519 };
    });
    expect(keys.ed25519).toBeTruthy();
    const published = await publishedDeviceKeys(alice.token, userId('alice'), session!.deviceId);
    expect(published?.[`ed25519:${session!.deviceId}`], 'device keys published on the server').toBe(keys.ed25519);

    // AC-E1-5, dev-server half: the wasm is fetched (not inlined) and no optimizeDeps / wasm error.
    expect(wasm.some((st) => st === 200 || st === 304), `wasm responses: ${wasm.join(',')}`).toBe(true);
    expect(errors.filter((e) => /optimizeDeps|\.wasm|WebAssembly/i.test(e)), 'wasm/optimizeDeps console errors').toEqual([]);
  });

  test('AC-E1-2 store per device, reload keeps the same device and state', async ({ page }) => {
    await loginWith(page, 'alice');
    const before = await waitForStatus(page);
    const deviceId = before.status.deviceId;
    expect((await dbNames(page)).some((n) => n.startsWith(`matrix-poc-crypto:@alice:localhost:${deviceId}`)), 'IndexedDB per user + device').toBe(true);
    const devicesBefore = new Set((await devicesOf(alice.token)).map((d) => d.device_id));

    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    const after = await waitForStatus(page);
    expect(after.status.deviceId).toBe(deviceId);
    expect((await storedSession(page))!.deviceId).toBe(deviceId);
    expect(after.cryptoReady).toBe(true);
    for (const k of ['verified', 'hasCrossSigningKeys', 'secretStorageReady'] as const) expect(after.status[k], k).toBe(before.status[k]);
    expect(after.status.backup.version).toBe(before.status.backup.version);

    const newDevices = (await devicesOf(alice.token)).filter((d) => !devicesBefore.has(d.device_id));
    if (newDevices.length) annotate('concurrent-login', `${newDevices.length} alice device(s) appeared during the reload (devs share the server); this session kept ${deviceId}`);
    expect(newDevices.map((d) => d.device_id)).not.toContain(deviceId);
  });

  test('AC-E1-3 logout wipes the crypto store; the next login is a new device', async ({ page }) => {
    await loginWith(page, 'alice');
    const first = (await waitForStatus(page)).status.deviceId;
    expect((await cryptoDbNames(page)).length).toBeGreaterThan(0);

    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expectCryptoWiped(page);
    expect(await storedSession(page)).toBeNull();

    await loginWith(page, 'alice');
    const second = (await waitForStatus(page)).status.deviceId;
    expect(second).not.toBe(first);
    await uiHalf('Dev A', ['security-banner'], async () => {
      await expect(page.getByTestId('security-banner'), 'a new device shows a banner again').toBeVisible({ timeout: 15_000 });
    });
  });

  test('AC-E1-4 a rejected token wipes the same way and says "Session expired"', async ({ page }) => {
    await loginWith(page, 'alice');
    const deviceId = (await waitForStatus(page)).status.deviceId;
    expect((await cryptoDbNames(page)).length).toBeGreaterThan(0);

    await deleteDevice(alice.token, 'alice', deviceId);
    // The app notices on its next request (the /sync long-poll is up to 30 s).
    await expect(page.getByTestId('login-form')).toBeVisible({ timeout: 60_000 });
    await expectCryptoWiped(page);
    expect(await storedSession(page)).toBeNull();
    // BUG-11 regression (61e6cef): the mid-session token rejection says why on the login form.
    await expect(page.getByText(/Session expired/i), 'login form says "Session expired"').toBeVisible();
  });
});

/* ================================================================== layout regression */

test('regression (21179cb a): the members panel sits beside main and the page does not scroll (security-dialogs-host grid bug)', async ({ page }) => {
  await loginWith(page, 'alice');
  await waitForStatus(page);
  if (!(await channelItem(page, R.general).isVisible().catch(() => false))) await openSpace(page, R.acme);
  await openChannel(page, R.general);
  const members = page.locator('aside[aria-label="Members"]');
  await expect(members).toBeVisible();
  const [m, main] = await Promise.all([members.boundingBox(), page.locator('main').first().boundingBox()]);
  expect(m!.y, 'members top === main top').toBe(main!.y);
  expect(await page.evaluate(() => document.documentElement.scrollHeight === window.innerHeight), 'no page scroll').toBe(true);
});

/* ================================================================== AC-E6 encrypted by default */

test.describe('AC-E6 encrypted by default', () => {
  test('AC-E6-1 new channel and DM are encrypted from the first message; a new space is not', async ({ page }) => {
    await loginWith(page, 'alice');
    await waitForStatus(page);

    // channel (in Gaming, like the Phase 1 create tests, so Acme HQ stays clean)
    await openSpace(page, R.gaming);
    await page.getByTestId('channel-add').click();
    await expect(page.getByTestId('create-channel-dialog')).toBeVisible();
    await uiHalf('Dev A', ['create-channel-encrypted-note'], async () => {
      await expect(page.getByTestId('create-channel-encrypted-note')).toBeVisible();
    });
    const name = uniqueName('e2ee');
    await page.getByTestId('create-channel-name').fill(name);
    await page.getByTestId('create-channel-submit').click();
    await expect(page.getByTestId('create-channel-dialog')).toHaveCount(0, { timeout: 30_000 });
    const item = byName(page.getByTestId('channel-list'), name);
    await expect(item).toBeVisible({ timeout: 30_000 });
    const roomId = (await item.getAttribute('data-testid'))!.replace('channel-item-', '');
    created.push({ roomId, parent: R.gaming });
    expect(await stateContent(alice.token, roomId, 'm.room.encryption')).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
    await uiHalf('Dev A', ['channel-header-lock'], async () => {
      await expect(page.getByTestId('channel-header-lock')).toBeVisible();
      await expect(channelItem(page, roomId)).toHaveAttribute('data-encrypted', 'true');
    });
    const first = uniq('first in new channel');
    await typeAndSend(page, first);
    expectEncryptedOnWire(await rawEvent(alice.token, roomId, await settledEventId(rowByText(page, first), 20_000)), { label: 'first channel message' });

    // DM with a throwaway user (always a new room)
    const other = await freshUser('qadm');
    await openHome(page);
    await page.getByTestId('dm-new').click();
    await expect(page.getByTestId('new-dm-dialog')).toBeVisible();
    await uiHalf('Dev A', ['new-dm-encrypted-note'], async () => {
      await expect(page.getByTestId('new-dm-encrypted-note')).toBeVisible();
    });
    await page.getByTestId('new-dm-user-id').fill(other.userId);
    await page.getByTestId('new-dm-submit').click();
    await expect(page.getByTestId('new-dm-dialog')).toHaveCount(0, { timeout: 30_000 });
    const dm = byName(page.getByTestId('dm-list'), other.username);
    await expect(dm).toBeVisible({ timeout: 30_000 });
    const dmId = (await dm.getAttribute('data-testid'))!.replace('dm-item-', '');
    created.push({ roomId: dmId });
    expect(await stateContent(alice.token, dmId, 'm.room.encryption')).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
    await uiHalf('Dev A', ['channel-header-lock'], async () => {
      await expect(page.getByTestId('channel-header-lock')).toBeVisible();
      await expect(page.getByTestId(`dm-item-${dmId}`)).toHaveAttribute('data-encrypted', 'true');
    });
    const dmFirst = uniq('first in new dm');
    await typeAndSend(page, dmFirst);
    expectEncryptedOnWire(await rawEvent(alice.token, dmId, await settledEventId(rowByText(page, dmFirst), 20_000)), { label: 'first DM message' });

    // space: plain
    await page.getByTestId('space-add').click();
    const spaceName = uniqueName('e2eesp');
    await page.getByTestId('create-space-name').fill(spaceName);
    await page.getByTestId('create-space-submit').click();
    await expect(page.getByTestId('create-space-dialog')).toHaveCount(0, { timeout: 30_000 });
    const rail = byName(page.getByTestId('space-rail'), spaceName);
    await expect(rail).toBeVisible({ timeout: 30_000 });
    const spaceId = (await rail.getAttribute('data-testid'))!.replace('space-item-', '');
    created.push({ roomId: spaceId });
    expect(await stateContent(alice.token, spaceId, 'm.room.encryption'), 'spaces stay unencrypted').toBeUndefined();
  });

  test('AC-E6-2 lock in #vault, none in #general', async ({ page }) => {
    requireUi('Dev A', 'channel-header-lock');
    await loginWith(page, 'alice');
    await openVault(page);
    await expect(page.getByTestId('channel-header-lock')).toBeVisible();
    await expect(page.getByTestId('channel-header-lock')).toHaveAttribute('title', 'End-to-end encrypted');
    await expect(channelItem(page, R.vault)).toHaveAttribute('data-encrypted', 'true');
    await openChannel(page, R.general);
    await expect(page.getByTestId('channel-header-lock')).toHaveCount(0);
    await expect(channelItem(page, R.general)).toHaveAttribute('data-encrypted', 'false');
  });

  test('AC-E6-3 #vault composer is encrypted and keys are prepared before the first send', async ({ page }) => {
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openChannel(page, R.general);
    const keyRequests: string[] = [];
    page.on('request', (r) => {
      if (/\/keys\/(claim|query)/.test(r.url())) keyRequests.push(r.url());
    });
    let sent = false;
    page.on('request', (r) => {
      if (/\/send\/m\.room\.encrypted\//.test(r.url())) sent = true;
    });
    await openVault(page);
    await composer(page).click();
    await expect.poll(() => keyRequests.length, { timeout: 10_000, message: 'a /keys/query or /keys/claim after opening #vault / focusing the composer' }).toBeGreaterThan(0);
    expect(sent, 'no send happened yet').toBe(false);
    await uiHalf('Dev B', ['composer'], async () => {
      if (await page.getByTestId('composer').count()) {
        await expect(page.getByTestId('composer')).toHaveAttribute('data-encrypted', 'true');
      }
    });
    await expect.soft(composer(page), 'DEV-B-29 placeholder').toHaveAttribute('placeholder', 'Message #vault (encrypted)');
    await openChannel(page, R.general);
    await expect(composer(page)).toHaveAttribute('placeholder', /^Message #general$/);
  });

  test('AC-E6-4 no preview_url request while viewing or sending links in #vault', async ({ page }) => {
    const previews: string[] = [];
    await page.route(/preview_url/, (route) => {
      previews.push(route.request().url());
      return route.abort();
    });
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const text = `${uniq('link')} https://example.com/e2ee-${Date.now()}`;
    await typeAndSend(page, text);
    await settledEventId(rowByText(page, 'https://example.com/e2ee-'), 20_000);
    await page.waitForTimeout(2_000);
    // Phase 6: the landing room (#general, plain) previews its seeded link (`https://status.example.com`) automatically,
    // which is correct; the criterion is about the link sent in #vault.
    expect(previews.filter((u) => u.includes(encodeURIComponent('https://example.com/e2ee-'))), 'preview_url requests for the #vault link').toEqual([]);
  });

  test('AC-E6-5 a GIF in #vault is click-to-load (P1)', async ({ page }) => {
    requireUi('Dev B', 'message-gif-load');
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const gifRequests: string[] = [];
    page.on('request', (r) => {
      if (/gif-fixtures\/.+\.(gif|webp)/.test(r.url())) gifRequests.push(r.url());
    });
    const eventId = await page.evaluate(async (roomId) => {
      const w = (window as any).__matrixPoc;
      w.gif.setGifProvider('mock');
      const page1 = await w.gif.getGifProvider().trending({ limit: 8 });
      return w.actions.sendGif(roomId, page1.results[0]);
    }, R.vault);
    const settled = eventId.startsWith('$') ? eventId : await settledEventId(page.getByTestId('message-list').getByTestId(/^message-[$~]/).last());
    expectEncryptedOnWire(await rawEvent(alice.token, R.vault, settled), { label: 'GIF message' });
    const gif = row(page, settled).getByTestId('message-gif');
    await expect(gif).toHaveAttribute('data-state', 'click-to-load', { timeout: 15_000 });
    await expect(gif.locator('img')).toHaveCount(0);
    const fullBefore = gifRequests.filter((u) => /\.gif/.test(u)).length;
    await row(page, settled).getByTestId('message-gif-load').click();
    await expect(gif).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
    expect(gifRequests.filter((u) => /\.gif/.test(u)).length).toBeGreaterThan(fullBefore);
  });

  test('AC-E6-6 a room that turns encrypted while open flips, and never flips back (P1)', async ({ page }) => {
    const roomId = await createRoom(alice.token, { name: uniqueName('e2eeflip'), spaceId: R.gaming, invite: [userId('bob')], powerUsers: { [userId('bob')]: 100 }, preset: 'public_chat' });
    created.push({ roomId, parent: R.gaming });
    await joinRoom(bob.token, roomId);
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openSpace(page, R.gaming);
    await expect(channelItem(page, roomId)).toBeVisible({ timeout: 20_000 });
    await openChannel(page, roomId);
    const plain = uniq('before encryption');
    await typeAndSend(page, plain);
    expect((await rawEvent(alice.token, roomId, await settledEventId(rowByText(page, plain), 20_000))).type).toBe('m.room.message');

    await setRoomEncryption(bob.token, roomId);
    await uiHalf('Dev A', ['channel-header-lock'], async () => {
      await expect(page.getByTestId('channel-header-lock')).toBeVisible({ timeout: 15_000 });
    });
    await uiHalf('Dev B', ['composer'], async () => {
      if (await page.getByTestId('composer').count()) await expect(page.getByTestId('composer')).toHaveAttribute('data-encrypted', 'true', { timeout: 15_000 });
    });
    await expect.poll(() => page.evaluate((r) => (window as any).__matrixPoc.utils.isRoomEncrypted(r), roomId), { timeout: 15_000 }).toBe(true);
    const secret = uniq('after encryption');
    await typeAndSend(page, secret);
    expectEncryptedOnWire(await rawEvent(alice.token, roomId, await settledEventId(rowByText(page, secret), 20_000)), { label: 'first send after the flip' });

    // bob tries to turn it off: the client must keep encrypting.
    await sendStateEvent(bob.token, roomId, 'm.room.encryption', '', {});
    await page.waitForTimeout(2_000);
    const still = uniq('after removal attempt');
    await typeAndSend(page, still);
    expectEncryptedOnWire(await rawEvent(alice.token, roomId, await settledEventId(rowByText(page, still), 20_000)), { label: 'send after removal attempt' });
  });
});
