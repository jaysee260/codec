/**
 * "Second secret-storage key mid-unlock" (production bug 2026-10-18; design recovery-ux/DESIGN.md). Desktop.
 *
 * The account has two secret-storage keys: K1 (default; protects the cross-signing keys) and K2 (not default;
 * `m.megolm_backup.v1` is encrypted under K2 only). A new device unlocks with K1: cross-signing succeeds, then the
 * backup secret cannot be opened with K1. Originally the dialog hung on "Unlocking..." (a K2 prompt it never
 * rendered). Final design, "One ask only": a normal unlock never asks for another key; it ends in E2 ("Older
 * messages can't be unlocked yet", `locked`, reason `no-key`), and K2 is only asked for from E2's explicit
 * "I have a different recovery key" (`recovery-enter-other-key` -> `prompt`).
 *
 * Seeding (per test, throwaway account, `freshUser()`): device A sets up recovery with the store (K1) and sends a
 * few encrypted messages that reach the backup; then, through A's client, adds K2 (`secretStorage.addKey`, a fresh
 * key, not default) and re-stores the backup key under K2 only. A logs out before B logs in, so nothing can gossip
 * the backup key to B.
 *
 * Cases: K1 -> E2 (never `prompt`); different key: Cancel -> `locked` (cancelled), wrong key -> `locked`
 * (wrong-key), K2 -> `done`; Hide (X) at the different-key prompt keeps the restore and prompt alive; the same
 * after the E2 banner was dismissed (a pending prompt overrides the dismissal); O2a: a reload in E2 never shows
 * `unlock`, and the per-device dismissal keeps the banner away across reloads.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { channelItem, openChannel, openSpace, row, rowByText, settledEventId, typeAndSend } from './fixtures/ui.ts';
import { accountData, createRoom, defaultSecretStorageKey, freshUser, keyBackup, type Credentials } from './fixtures/e2ee-api.ts';
import {
  cryptoApiCall,
  cryptoState,
  e2eeAfterEach,
  expectUtd,
  loginWith,
  openSecurityDialog,
  secondContext,
  setupViaStore,
  waitForCrypto,
  watchRecoveryPhases,
  waitForStatus,
  type Account,
} from './fixtures/e2ee.ts';
import { annotate } from './fixtures/state.ts';

test.describe.configure({ timeout: 240_000 });

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
});

interface Seeded extends Credentials {
  acct: Account;
  spaceId: string;
  roomId: string;
  /** K1, the default key (what setup showed the user). */
  k1: string;
  k1Id: string;
  /** K2, the second key the backup secret is encrypted under (recovery-key form). */
  k2: string;
  k2Id: string;
  texts: string[];
  ids: string[];
}

async function openRoom(page: Page, u: { roomId: string; spaceId: string }): Promise<void> {
  if (!(await channelItem(page, u.roomId).isVisible().catch(() => false))) await openSpace(page, u.spaceId);
  await openChannel(page, u.roomId);
}

/** A fresh account whose `m.megolm_backup.v1` is encrypted under a second, non-default key only. */
async function seedSecondKeyAccount(browser: Browser, prefix: string): Promise<Seeded> {
  const u = await freshUser(prefix);
  const spaceId = await createRoom(u.token, { name: `QA ${prefix}`, space: true });
  const roomId = await createRoom(u.token, { name: 'secrets', encrypted: true, spaceId });
  const acct: Account = { username: u.username, password: u.password, displayName: u.username };

  const A = await secondContext(browser, acct);
  const a = A.page;
  await waitForStatus(a);
  const k1 = await setupViaStore(a);
  await waitForCrypto(a, (s) => !!s.status?.verified && !!s.status.backup.version, 'A verified with a backup after setup', 30_000);
  const k1Id = await defaultSecretStorageKey(u.token, u.userId);
  expect(k1Id, 'K1 is the default key').toBeTruthy();

  // Encrypted history that only the backup can unlock on a new device.
  await openRoom(a, { roomId, spaceId });
  const texts: string[] = [];
  const ids: string[] = [];
  for (let i = 1; i <= 2; i += 1) {
    const t = `[qa] second key ${i} ${Date.now().toString(36)}`;
    texts.push(t);
    await typeAndSend(a, t);
    ids.push(await settledEventId(rowByText(a, t), 20_000));
  }
  await expect.poll(async () => (await keyBackup(u.token))?.count ?? 0, { timeout: 40_000, message: 'backup holds the room keys' }).toBeGreaterThan(0);
  await waitForCrypto(a, (s) => (s.backupRemaining ?? 1) === 0, 'backup upload done', 40_000);

  // K2: a fresh key, added but NOT made default; the backup key re-stored under K2 only.
  const k2 = await a.evaluate(async () => {
    const w = (window as any).__matrixPoc;
    const client = w.getClient();
    const api = client.getCrypto();
    const generated = await api.createRecoveryKeyFromPassphrase();
    const { keyId } = await client.secretStorage.addKey('m.secret_storage.v1.aes-hmac-sha2', { key: generated.privateKey, name: 'qa second key' });
    // `store` asks getSecretStorageKey for K2: cache it so A's own prompt is not involved.
    w.cryptoLifecycle.cacheSecretStorageKey(keyId, generated.privateKey);
    const backupKey: Uint8Array | null = await api.getSessionBackupPrivateKey();
    if (!backupKey) throw new Error('A has no backup private key');
    let bin = '';
    for (const b of backupKey) bin += String.fromCharCode(b);
    await client.secretStorage.store('m.megolm_backup.v1', btoa(bin), [keyId]);
    return { keyId: keyId as string, encoded: generated.encodedPrivateKey as string };
  });
  const stored = await accountData<{ encrypted?: Record<string, unknown> }>(u.token, u.userId, 'm.megolm_backup.v1');
  expect(Object.keys(stored?.encrypted ?? {}), 'm.megolm_backup.v1 is encrypted under K2 only').toEqual([k2.keyId]);
  expect(await defaultSecretStorageKey(u.token, u.userId), 'K1 stays the default key').toBe(k1Id);
  const cs = await accountData<{ encrypted?: Record<string, unknown> }>(u.token, u.userId, 'm.cross_signing.master');
  expect(Object.keys(cs?.encrypted ?? {}), 'cross-signing master stays under K1').toEqual([k1Id]);

  await A.close(); // logout: A cannot gossip the backup key to B
  return { ...u, acct, spaceId, roomId, k1, k1Id: k1Id!, k2: k2.encoded, k2Id: k2.keyId, texts, ids };
}

const E2_TITLE = "Older messages can't be unlocked yet";

/**
 * New device B (the test's `page`): history locked, then a normal unlock with K1 through the recovery dialog.
 * K1 verifies the session; the backup secret is under K2, so the unlock ends in E2 (`locked`), never in `prompt`.
 */
async function unlockWithK1UntilLocked(page: Page, U: Seeded): Promise<void> {
  await loginWith(page, U.acct);
  await waitForStatus(page);
  await openRoom(page, U);
  for (const id of U.ids) await expectUtd(page, id, 'locked-backup', 20_000);

  await expect(page.getByTestId('security-banner')).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
  await page.getByTestId('security-banner-action').click();
  await page.getByTestId('verify-use-recovery').click();
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toHaveAttribute('data-phase', 'form');

  const watch = watchRecoveryPhases(page);
  try {
    await page.getByTestId('recovery-input').fill(U.k1);
    await page.getByTestId('recovery-submit').click();
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 60_000 });
  } finally {
    watch.stop();
  }
  annotate('phases', watch.phases.join(' > '));
  expect(watch.phases, 'a normal unlock never shows the prompt phase').not.toContain('prompt');
  expect(watch.prompts, 'a normal unlock never asks for another key').toEqual([]);
  await expectE2(page, 'locked');
  await expect(page.getByTestId('recovery-locked')).toHaveAttribute('data-reason', 'no-key');
  const s = await cryptoState(page);
  expect(s.recovery.busy).toBeNull();
  expect(s.prompt).toBeNull();
  expect((s.recovery as { backupLocked?: { reason: string } | null }).backupLocked?.reason).toBe('no-key');
  await expectVerified(page);
}

/** The E2 screen ("Older messages can't be unlocked yet") in `phase`, with its options. */
async function expectE2(page: Page, phase: 'locked' | 'unavailable'): Promise<void> {
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toHaveAttribute('data-phase', phase);
  await expect(dialog).toContainText(E2_TITLE);
  await expect(page.getByTestId('recovery-locked')).toBeVisible();
  await expect(page.getByTestId('recovery-unavailable')).toBeVisible();
  await expect(page.getByTestId('recovery-import')).toBeVisible();
  await expect(page.getByTestId('recovery-enter-other-key')).toBeVisible();
  await expect(page.getByTestId('recovery-retry'), 'retry only after a network failure').toHaveCount(0);
  await expect(page.getByTestId('recovery-other-device'), 'no other verified device (A logged out)').toHaveCount(0);
  await expect(page.getByTestId('recovery-reset-backup'), 'nothing destructive in E2').toHaveCount(0);
  await expect(dialog.getByTestId('dialog-close').last()).toBeVisible();
}

/** E2 -> "I have a different recovery key" -> the K2 prompt (the only way to `prompt`). */
async function enterOtherKey(page: Page): Promise<void> {
  const dialog = page.getByTestId('recovery-dialog');
  await page.getByTestId('recovery-enter-other-key').click();
  await expect(dialog).toHaveAttribute('data-phase', 'prompt', { timeout: 30_000 });
  const s = await cryptoState(page);
  expect(s.prompt?.kind).toBe('recovery-key');
  expect.soft((s.prompt as { secretName?: string } | null)?.secretName, 'prompt names the secret').toBe('m.megolm_backup.v1');
  await expect(page.getByTestId('recovery-input')).toBeVisible();
  await expect(page.getByTestId('recovery-submit')).toBeVisible();
  await expect(page.getByTestId('recovery-prompt-cancel')).toBeVisible();
}

async function expectVerified(page: Page): Promise<void> {
  await waitForCrypto(page, (s) => !!s.status?.verified, 'status.verified', 30_000);
  await expect(page.getByTestId('current-user')).toHaveAttribute('data-verified', 'true', { timeout: 15_000 });
}

async function expectHistoryReadable(page: Page, U: Seeded): Promise<void> {
  for (const [i, id] of U.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(U.texts[i]!, { timeout: 15_000 });
}

test.describe('second secret-storage key mid-unlock', () => {
  test('K1 unlock ends in E2 (locked, never prompt); different key: Cancel -> locked, wrong -> wrong-key, K2 -> done', async ({ page, browser }) => {
    const U = await seedSecondKeyAccount(browser, 'qak2cancel');
    await unlockWithK1UntilLocked(page, U);
    const dialog = page.getByTestId('recovery-dialog');
    const locked = page.getByTestId('recovery-locked');
    // History stays locked: no backup key on this device.
    expect(await cryptoApiCall(page, 'getSessionBackupPrivateKey'), 'no backup key cached').toBeNull();
    for (const id of U.ids) await expectUtd(page, id, /.+/, 10_000);

    // "I have a different recovery key" -> prompt; Cancel -> back to E2 (cancelled).
    // Regression: Cancel used to submit the form (the button node was reused as E2's submit Done) and close the dialog.
    await enterOtherKey(page);
    await page.getByTestId('recovery-prompt-cancel').click();
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 30_000 });
    await expect(locked).toHaveAttribute('data-reason', 'cancelled');
    expect((await cryptoState(page)).prompt).toBeNull();

    // A wrong (well-formed) key at the prompt -> E2 (wrong-key), still verified.
    await enterOtherKey(page);
    const otherKey = await page.evaluate(async () => (await (window as any).__matrixPoc.security.getCryptoApi().createRecoveryKeyFromPassphrase()).encodedPrivateKey as string);
    await page.getByTestId('recovery-input').fill(otherKey);
    await page.getByTestId('recovery-submit').click();
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 30_000 });
    await expect(locked).toHaveAttribute('data-reason', 'wrong-key');
    await expectVerified(page);

    // K2 -> done ("Restored X of Y keys"), and the history decrypts.
    await enterOtherKey(page);
    await page.getByTestId('recovery-input').fill(U.k2);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toHaveAttribute('data-phase', 'done');
    await expect(dialog).toContainText('Unlocked');
    await expect(page.getByTestId('recovery-done')).toContainText(/Restored \d+ of \d+ keys/);
    const s = await cryptoState(page);
    expect(s.recovery.lastRestore?.imported ?? 0, 'keys restored from the backup').toBeGreaterThan(0);
    expect((s.recovery as { backupLocked?: unknown }).backupLocked ?? null, 'a successful restore clears backupLocked').toBeNull();
    await dialog.getByTestId('dialog-close').last().click();
    await expectHistoryReadable(page, U);
    await expect(page.getByTestId('security-banner'), 'nothing left to nag about').toHaveCount(0, { timeout: 10_000 });
  });

  test('Hide (X) at the different-key prompt keeps the restore and the prompt alive; K2 still finishes it', async ({ page, browser }) => {
    const U = await seedSecondKeyAccount(browser, 'qak2hide');
    await unlockWithK1UntilLocked(page, U);
    await enterOtherKey(page);
    const dialog = page.getByTestId('recovery-dialog');

    await dialog.getByTestId('recovery-close').click();
    // The close must not answer the prompt: the restore keeps waiting for it (checked over ~2 s, not one tick).
    for (let i = 0; i < 4; i += 1) {
      await page.waitForTimeout(500);
      const s = await cryptoState(page);
      expect(s.recovery.busy, 'Hide does not end the restore').toBe('restore');
      expect(s.prompt?.kind, 'Hide does not cancel the prompt').toBe('recovery-key');
    }
    // The dialog either re-opened by itself with the prompt, or the banner re-opens it.
    if (!(await dialog.isVisible().catch(() => false))) {
      annotate('hide', 'recovery-dialog stayed closed after X; re-opened from the banner');
      await expect(page.getByTestId('security-banner')).toHaveAttribute('data-need', 'unlock', { timeout: 10_000 });
      await page.getByTestId('security-banner-action').click();
    } else {
      annotate('hide', 'recovery-dialog re-opened by itself with the pending prompt');
    }
    await expect(dialog).toHaveAttribute('data-phase', 'prompt', { timeout: 10_000 });

    await page.getByTestId('recovery-input').fill(U.k2);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
    await expectVerified(page);
    await dialog.getByTestId('dialog-close').last().click();
    await expectHistoryReadable(page, U);
  });

  test('Hide (X) at the prompt after the E2 banner was dismissed: the banner comes back and reopens the prompt', async ({ page, browser }) => {
    // BLOCKING review finding: with the banner dismissed, X on a pending prompt left no way back to it (the
    // restore waited forever). A pending recovery-key prompt must override the dismissal.
    const U = await seedSecondKeyAccount(browser, 'qak2dismiss');
    await unlockWithK1UntilLocked(page, U);
    const dialog = page.getByTestId('recovery-dialog');
    const bannerEl = page.getByTestId('security-banner');

    // E2 -> Done -> the banner reads "Older messages are locked · Fix".
    await dialog.getByTestId('dialog-close').last().click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(bannerEl).toHaveAttribute('data-need', 'unavailable', { timeout: 20_000 });
    await expect(bannerEl).toContainText('Older messages are locked');
    await expect(page.getByTestId('security-banner-action')).toHaveText(/Fix/);

    // The user dismisses it, then reaches the recovery dialog another way.
    await page.getByTestId('security-banner-dismiss').click();
    await expect(bannerEl).toHaveCount(0);
    await openSecurityDialog(page, 'unlock');
    await expectE2(page, 'locked');
    await enterOtherKey(page);

    // X hides the dialog; the prompt stays pending, and the dismissed banner must come back for it.
    await dialog.getByTestId('recovery-close').click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    expect((await cryptoState(page)).prompt?.kind, 'X does not cancel the prompt').toBe('recovery-key');
    await expect(bannerEl, 'banner reappears while the prompt is pending').toHaveAttribute('data-need', 'unlock', { timeout: 10_000 });

    // Dismissing again while the prompt is pending does not hide it either (the banner is the only way back).
    await page.getByTestId('security-banner-dismiss').click();
    await page.waitForTimeout(500);
    await expect(bannerEl, 'a dismissal cannot hide a pending prompt').toHaveAttribute('data-need', 'unlock');

    await page.getByTestId('security-banner-action').click();
    await expect(dialog).toHaveAttribute('data-phase', 'prompt', { timeout: 10_000 });
    await page.getByTestId('recovery-input').fill(U.k2);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
    await expectVerified(page);
    await dialog.getByTestId('dialog-close').last().click();
    await expectHistoryReadable(page, U);
  });

  test('O2a reload in E2: the banner never says `unlock`; once dismissed (per device) it shows nothing at all, across reloads', async ({ page, browser }) => {
    const U = await seedSecondKeyAccount(browser, 'qak2reload');
    await unlockWithK1UntilLocked(page, U);
    const dialog = page.getByTestId('recovery-dialog');
    const bannerEl = page.getByTestId('security-banner');
    await dialog.getByTestId('dialog-close').last().click();
    await expect(bannerEl).toHaveAttribute('data-need', 'unavailable', { timeout: 20_000 });

    // Every banner need painted from the first frame of each reload.
    await page.addInitScript(() => {
      const w = window as unknown as { __qaNeeds?: string[] };
      w.__qaNeeds = [];
      const seen = (): void => {
        const n = document.querySelector('[data-testid="security-banner"]')?.getAttribute('data-need');
        if (n && w.__qaNeeds![w.__qaNeeds!.length - 1] !== n) w.__qaNeeds!.push(n);
      };
      new MutationObserver(seen).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-need'] });
    });
    const needsSeen = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __qaNeeds?: string[] }).__qaNeeds ?? []);
    const reload = async (): Promise<void> => {
      await page.reload();
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
      await waitForStatus(page);
    };

    // Reload 1, not dismissed: `unavailable` right away (no 10 s wait after a reload), never `unlock` on the way.
    await reload();
    await expect(bannerEl, 'E2 banner right after the reload').toHaveAttribute('data-need', 'unavailable', { timeout: 5_000 });
    await page.waitForTimeout(3_000);
    const first = await needsSeen();
    annotate('reload-1', `banner needs: ${first.join(' > ')}`);
    expect(first, 'never `unlock` on a reload in E2').not.toContain('unlock');
    expect(first[first.length - 1]).toBe('unavailable');

    // Dismiss, reload 2: nothing at all, from the first paint and for 12 s.
    await page.getByTestId('security-banner-dismiss').click();
    await expect(bannerEl).toHaveCount(0);
    await reload();
    await expectVerified(page);
    await page.waitForTimeout(12_000);
    expect(await needsSeen(), 'no banner at all after a reload with the dismissal set').toEqual([]);
    await expect(bannerEl).toHaveCount(0);
    expect(await page.evaluate(() => !!(window as any).__matrixPoc.security.store.getState().historyUnavailable), 'the store still knows E2').toBe(true);
    // The dialog still offers E2 on demand.
    await openSecurityDialog(page, 'unlock');
    await expectE2(page, 'unavailable');
    expect(await page.getByTestId('recovery-locked').getAttribute('data-reason'), 'no attempt this session -> no reason').toBeNull();
  });
});
