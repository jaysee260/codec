/**
 * "Second secret-storage key mid-unlock" (production bug 2026-10-18, scratchpad CONTRACT.md A-D). Desktop.
 *
 * The account has two secret-storage keys: K1 (default; protects the cross-signing keys) and K2 (not default;
 * `m.megolm_backup.v1` is encrypted under K2 only). A new device unlocks with K1: cross-signing succeeds, then the
 * SDK asks `getSecretStorageKey` for K2 to read the backup key. Before the fix the recovery dialog never rendered
 * that prompt while busy (data-phase stayed `working`, "Unlocking..." forever) and Hide cancelled the whole unlock.
 *
 * Seeding (per test, throwaway account, `freshUser()`): device A sets up recovery with the store (K1) and sends a
 * few encrypted messages that reach the backup; then, through A's client, adds K2 (`secretStorage.addKey`, a fresh
 * key, not default) and re-stores the backup key under K2 only. A logs out before B logs in, so nothing can gossip
 * the backup key to B: B must get it from secret storage, i.e. through the K2 prompt.
 *
 * Cases: Cancel at the prompt -> `locked` (verified, history locked), then `recovery-retry` with a wrong key ->
 * `locked` (wrong-key), `recovery-retry` with K2 -> `done`; K2 at the first prompt -> `done` (history decrypts);
 * Hide (X) at the prompt -> the unlock and the prompt stay alive (the banner re-opens the prompt) and K2 finishes it;
 * the same after the `unlock` banner was dismissed (a pending prompt overrides the dismissal).
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
  secondContext,
  setupViaStore,
  waitForCrypto,
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

const LOCKED_TEXT = 'Session verified. Older messages stay locked: the key backup is protected by a different recovery key';

interface Snap {
  phase: string | null;
  busy: string | null;
  prompt: string | null;
}

async function snap(page: Page): Promise<Snap> {
  const s = await cryptoState(page);
  const phase = await page.getByTestId('recovery-dialog').getAttribute('data-phase', { timeout: 500 }).catch(() => null);
  return { phase, busy: s.recovery.busy, prompt: s.prompt?.kind ?? null };
}

/**
 * New device B (the test's `page`): opens the history (locked), then unlocks with K1 through the recovery dialog
 * and waits until the K2 prompt renders while the unlock is still running. Records every data-phase seen.
 */
async function unlockWithK1UntilPrompt(page: Page, U: Seeded): Promise<{ phases: string[] }> {
  await loginWith(page, U.acct);
  await waitForStatus(page);
  await openRoom(page, U);
  for (const id of U.ids) await expectUtd(page, id, 'locked-backup', 20_000);

  await expect(page.getByTestId('security-banner')).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
  await page.getByTestId('security-banner-action').click();
  await page.getByTestId('verify-use-recovery').click();
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toHaveAttribute('data-phase', 'form');

  const phases: string[] = [];
  const watch = setInterval(() => {
    void dialog.getAttribute('data-phase', { timeout: 200 }).then((p) => {
      if (p && phases[phases.length - 1] !== p) phases.push(p);
    }).catch(() => undefined);
  }, 100);
  try {
    await page.getByTestId('recovery-input').fill(U.k1);
    await page.getByTestId('recovery-submit').click();
    // Before the fix: { phase: 'working', busy: 'unlock', prompt: 'recovery-key' } forever (the hang).
    await expect
      .poll(() => snap(page), { timeout: 30_000, intervals: [250, 500], message: 'recovery-dialog renders the K2 prompt while the unlock is still busy' })
      .toEqual({ phase: 'prompt', busy: 'unlock', prompt: 'recovery-key' });
  } finally {
    clearInterval(watch);
  }
  annotate('phases', phases.join(' > '));

  const s = await cryptoState(page);
  expect.soft((s.prompt as { secretName?: string } | null)?.secretName, 'prompt names the secret').toBe('m.megolm_backup.v1');
  expect.soft((s.prompt as { differentKey?: boolean } | null)?.differentKey, 'prompt knows a different key was entered').toBe(true);
  await expect.soft(dialog.locator('[data-different-key="true"]'), 'prompt text says the backup uses a different key').toBeVisible();
  await expect(page.getByTestId('recovery-input')).toBeVisible();
  await expect(page.getByTestId('recovery-submit')).toBeVisible();
  await expect(page.getByTestId('recovery-prompt-cancel')).toBeVisible();
  return { phases };
}

async function expectVerified(page: Page): Promise<void> {
  await waitForCrypto(page, (s) => !!s.status?.verified, 'status.verified', 30_000);
  await expect(page.getByTestId('current-user')).toHaveAttribute('data-verified', 'true', { timeout: 15_000 });
}

test.describe('second secret-storage key mid-unlock', () => {
  test('Cancel at the K2 prompt: verified + locked; a wrong key on retry stays locked; K2 on retry restores', async ({ page, browser }) => {
    const U = await seedSecondKeyAccount(browser, 'qak2cancel');
    await unlockWithK1UntilPrompt(page, U);
    const dialog = page.getByTestId('recovery-dialog');
    const locked = page.getByTestId('recovery-locked');

    await page.getByTestId('recovery-prompt-cancel').click();
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 30_000 });
    await expect(locked).toBeVisible();
    await expect(locked).toHaveAttribute('data-reason', 'cancelled');
    await expect(locked).toContainText(LOCKED_TEXT);
    await expect(page.getByTestId('recovery-reset-backup')).toBeVisible();
    await expect(page.getByTestId('recovery-retry')).toBeVisible();

    let s = await cryptoState(page);
    expect(s.recovery.busy, 'the unlock finished').toBeNull();
    expect(s.prompt, 'no prompt left pending').toBeNull();
    expect((s.recovery as { backupLocked?: { reason: string } | null }).backupLocked?.reason).toBe('cancelled');
    await expectVerified(page);
    // History stays locked: no backup key on this device.
    expect(await cryptoApiCall(page, 'getSessionBackupPrivateKey'), 'no backup key cached').toBeNull();
    for (const id of U.ids) await expectUtd(page, id, /.+/, 10_000);

    // Retry -> the K2 prompt again; a wrong (well-formed) key there ends locked with reason wrong-key.
    await page.getByTestId('recovery-retry').click();
    await expect(dialog).toHaveAttribute('data-phase', 'prompt', { timeout: 30_000 });
    const otherKey = await page.evaluate(async () => (await (window as any).__matrixPoc.security.getCryptoApi().createRecoveryKeyFromPassphrase()).encodedPrivateKey as string);
    await page.getByTestId('recovery-input').fill(otherKey);
    await page.getByTestId('recovery-submit').click();
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 30_000 });
    await expect(locked).toHaveAttribute('data-reason', 'wrong-key');
    await expect(locked).toContainText(LOCKED_TEXT);
    await expectVerified(page);

    // Retry -> K2 -> done, and the history decrypts.
    await page.getByTestId('recovery-retry').click();
    await expect(dialog).toHaveAttribute('data-phase', 'prompt', { timeout: 30_000 });
    await page.getByTestId('recovery-input').fill(U.k2);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
    s = await cryptoState(page);
    expect(s.recovery.lastRestore?.imported ?? 0, 'keys restored from the backup').toBeGreaterThan(0);
    expect((s.recovery as { backupLocked?: unknown }).backupLocked ?? null, 'a successful restore clears backupLocked').toBeNull();
    await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
    for (const [i, id] of U.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(U.texts[i]!, { timeout: 15_000 });
  });

  test('K2 typed at the prompt restores the backup: done, and the old messages decrypt', async ({ page, browser }) => {
    const U = await seedSecondKeyAccount(browser, 'qak2enter');
    await unlockWithK1UntilPrompt(page, U);

    await page.getByTestId('recovery-input').fill(U.k2);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('recovery-dialog')).toHaveAttribute('data-phase', 'done');
    const s = await cryptoState(page);
    expect(s.recovery.busy).toBeNull();
    expect(s.recovery.lastRestore?.imported ?? 0, 'keys restored from the backup').toBeGreaterThan(0);
    expect((s.recovery as { backupLocked?: unknown }).backupLocked ?? null).toBeNull();
    await expectVerified(page);

    await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
    for (const [i, id] of U.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(U.texts[i]!, { timeout: 15_000 });
  });

  test('Hide (X) at the K2 prompt keeps the unlock and the prompt alive; K2 still finishes it', async ({ page, browser }) => {
    const U = await seedSecondKeyAccount(browser, 'qak2hide');
    await unlockWithK1UntilPrompt(page, U);
    const dialog = page.getByTestId('recovery-dialog');

    await dialog.getByTestId('recovery-close').click();
    // The close must not answer the prompt: the unlock keeps waiting for it (checked over ~2 s, not one tick).
    for (let i = 0; i < 4; i += 1) {
      await page.waitForTimeout(500);
      const s = await cryptoState(page);
      expect(s.recovery.busy, 'Hide does not end the unlock').toBe('unlock');
      expect(s.prompt?.kind, 'Hide does not cancel the prompt').toBe('recovery-key');
      expect(s.recovery.error).toBeNull();
    }
    // The dialog either re-opened by itself with the prompt, or re-opens on demand with it still answerable.
    if (!(await dialog.isVisible().catch(() => false))) {
      annotate('hide', 'recovery-dialog stayed closed after X; re-opened from the banner');
      await page.getByTestId('security-banner-action').click();
      const viaRecovery = page.getByTestId('verify-use-recovery');
      if (await viaRecovery.isVisible({ timeout: 2000 }).catch(() => false)) await viaRecovery.click();
    } else {
      annotate('hide', 'recovery-dialog re-opened by itself with the pending prompt');
    }
    await expect(dialog).toHaveAttribute('data-phase', 'prompt', { timeout: 10_000 });

    await page.getByTestId('recovery-input').fill(U.k2);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
    await expectVerified(page);
    await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
    for (const [i, id] of U.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(U.texts[i]!, { timeout: 15_000 });
  });
  test('Hide (X) at the prompt after the unlock banner was dismissed: the banner comes back and reopens the prompt', async ({ page, browser }) => {
    // BLOCKING review finding: with `unlock` dismissed, X on a pending prompt left no way back to it (the unlock /
    // restore waited forever). A pending recovery-key prompt must override the dismissal.
    const U = await seedSecondKeyAccount(browser, 'qak2dismiss');
    await unlockWithK1UntilPrompt(page, U);
    const dialog = page.getByTestId('recovery-dialog');
    const bannerEl = page.getByTestId('security-banner');

    // K1 verified the session; cancelling the backup prompt leaves it `locked` -> the banner nags `unlock`.
    await page.getByTestId('recovery-prompt-cancel').click();
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 30_000 });
    await dialog.getByTestId('dialog-close').last().click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(bannerEl).toHaveAttribute('data-need', 'unlock', { timeout: 20_000 });

    // The user dismisses the unlock banner, then reaches the recovery dialog another way.
    await page.getByTestId('security-banner-dismiss').click();
    await expect(bannerEl).toHaveCount(0);
    await page.evaluate(async () => {
      const url = '/src/features/security/index.ts'; // Vite dev serves the module; a variable keeps tsc out of it
      const m = (await import(/* @vite-ignore */ url)) as { openSecurityDialog(kind: string): void };
      m.openSecurityDialog('unlock');
    });
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 10_000 });
    await page.getByTestId('recovery-retry').click();
    await expect(dialog).toHaveAttribute('data-phase', 'prompt', { timeout: 30_000 });

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
    for (const [i, id] of U.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(U.texts[i]!, { timeout: 15_000 });
  });
});
