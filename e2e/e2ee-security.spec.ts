/**
 * Phase 5 QA-27: verification, cross-signing, recovery key and key backup (AC-E4, AC-E5), plus the follow-up
 * regressions from the Principal's core fixes. Desktop, sequential.
 *
 * Every chain runs on a **throwaway account** (`freshUser()`, open registration on the local Synapse), never on
 * alice: cross-signing and secret storage cannot be undone without UIA, and the devs use alice by hand, so a
 * seeded account's state is not ours to rely on. The fresh account owns a plain space and one encrypted room in it.
 *
 * Devices: "A" is kept open across the chain (`keep: true`); B, C and D come and go one at a time, so at most
 * two contexts are open at once (AC-E8-1). `status.verified` can lag a tick after unlock / SAS: always poll.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { channelItem, messageList, openChannel, openSpace, row, rowByText, settledEventId, typeAndSend } from './fixtures/ui.ts';
import { openThreadFromMessage } from './fixtures/threads.ts';
import { createRoom, defaultSecretStorageKey, freshUser, hasCrossSigning, keyBackup, type Credentials } from './fixtures/e2ee-api.ts';
import {
  RECOVERY_KEY_RE,
  banner,
  closeDialog,
  cryptoApiCall,
  cryptoState,
  e2eeAfterEach,
  expectUtd,
  loginWith,
  sameEmoji,
  secondContext,
  setUpEncryption,
  setupViaStore,
  unlockViaStore,
  unlockWith,
  verifyBetween,
  verifyViaStore,
  waitForCrypto,
  waitForStatus,
  type Account,
  type SecondContext,
} from './fixtures/e2ee.ts';
import { annotate } from './fixtures/state.ts';

test.describe.configure({ timeout: 180_000 });

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
});

interface FreshAccount extends Credentials {
  acct: Account;
  spaceId: string;
  roomId: string;
}

async function freshAccount(prefix: string): Promise<FreshAccount> {
  const u = await freshUser(prefix);
  const spaceId = await createRoom(u.token, { name: `QA ${prefix}`, space: true });
  const roomId = await createRoom(u.token, { name: 'secrets', encrypted: true, spaceId });
  return { ...u, acct: { username: u.username, password: u.password, displayName: u.username }, spaceId, roomId };
}

async function openRoom(page: Page, u: FreshAccount): Promise<void> {
  if (!(await channelItem(page, u.roomId).isVisible().catch(() => false))) await openSpace(page, u.spaceId);
  await openChannel(page, u.roomId);
}

async function device(browser: Browser, u: FreshAccount, keep = false): Promise<SecondContext> {
  const c = await secondContext(browser, u.acct, { keep });
  await waitForStatus(c.page);
  return c;
}

const verifiedAttr = (page: Page) => page.getByTestId('current-user');

async function expectVerified(page: Page): Promise<void> {
  await waitForCrypto(page, (s) => !!s.status?.verified, 'status.verified', 30_000);
  await expect(verifiedAttr(page)).toHaveAttribute('data-verified', 'true', { timeout: 15_000 });
}

/* ================================================================== the main chain (one fresh account) */

test.describe.serial('fresh account: setup -> unlock -> verify -> backup', () => {
  let U: FreshAccount;
  let A: SecondContext;
  let recoveryKey = '';
  let defaultKeyId: string | null = null;
  const texts: string[] = [];
  const ids: string[] = [];

  test.beforeAll(async () => {
    U = await freshAccount('qasec');
  });

  test.afterAll(async () => {
    await A?.close();
  });

  test('AC-E4-1 a fresh account shows the setup banner', async ({ browser }) => {
    A = await device(browser, U, true);
    await expect(banner(A.page)).toHaveAttribute('data-need', 'setup', { timeout: 20_000 });
    await expect(A.page.getByTestId('security-banner-action')).toHaveText(/Set up/);
    // data-verified for this state is asserted on its own below (BUG-14) so it cannot stop the chain.
  });

  test('AC-E4-2 setup shows a 48-char key once, then cross-signing, secret storage and backup are live', async () => {
    const page = A.page;
    const phases: string[] = [];
    const watch = setInterval(() => {
      void page.getByTestId('setup-dialog').getAttribute('data-phase', { timeout: 200 }).then((p) => {
        if (p && phases[phases.length - 1] !== p) phases.push(p);
      }).catch(() => undefined);
    }, 100);
    try {
      recoveryKey = await setUpEncryption(page, U.password);
    } finally {
      clearInterval(watch);
    }
    expect(recoveryKey, 'Element format: 12 groups of 4 base58 chars').toMatch(RECOVERY_KEY_RE);
    expect(recoveryKey.replace(/ /g, '')).toHaveLength(48);
    expect(phases, `setup-dialog phases seen: ${phases.join(' > ')}`).toContain('key');

    expect(await cryptoApiCall<boolean>(page, 'isCrossSigningReady')).toBe(true);
    expect(await cryptoApiCall<boolean>(page, 'isSecretStorageReady')).toBe(true);
    const info = await cryptoApiCall<{ version: string }>(page, 'getKeyBackupInfo');
    expect(info?.version).toBeTruthy();
    expect(await cryptoApiCall<string>(page, 'getActiveSessionBackupVersion')).toBe(info!.version);
    await expectVerified(page);
    await expect(banner(page)).toHaveCount(0, { timeout: 15_000 });
    expect(await hasCrossSigning(U.token, U.userId)).toBe(true);
    expect((await keyBackup(U.token))?.version).toBe(info!.version);
    defaultKeyId = await defaultSecretStorageKey(U.token, U.userId);
    expect(defaultKeyId).toBeTruthy();
    await expect(page.getByTestId('setup-dialog')).toHaveCount(0);
  });

  test('AC-E5-6 (part 1) messages from the verified device are uploaded to the backup', async () => {
    const page = A.page;
    const before = (await keyBackup(U.token))?.count ?? 0;
    await openRoom(page, U);
    for (let i = 1; i <= 3; i += 1) {
      const t = `[qa] backed up ${i} ${Date.now().toString(36)}`;
      texts.push(t);
      await typeAndSend(page, t);
      ids.push(await settledEventId(rowByText(page, t), 20_000));
    }
    // the SDK starts uploading up to 10 s after the send
    await expect.poll(async () => (await keyBackup(U.token))?.count ?? 0, { timeout: 40_000, message: 'backup key count grows' }).toBeGreaterThan(before);
    await waitForCrypto(page, (s) => (s.backupRemaining ?? 0) === 0, 'backupRemaining reaches 0', 40_000);
  });

  test('AC-E5-1 + AC-E5-3 + AC-E5-2 + AC-E2-6 + AC-E5-5 new device: locked history, wrong keys refused, the key unlocks it all live', async ({ browser }) => {
    const B = await device(browser, U);
    const page = B.page;
    await expect(banner(page)).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
    await openRoom(page, U);
    for (const id of ids) {
      const ph = await expectUtd(page, id, 'locked-backup', 20_000);
      await expect(row(page, id).getByTestId('message-undecryptable-action')).toHaveText(/Unlock/);
      await expect.soft(ph, 'AC-E2-3 copy').toContainText('Unlock with your recovery key to read older messages');
    }

    // AC-E5-1: the verify dialog offers the recovery key
    await page.getByTestId('security-banner-action').click();
    await expect(page.getByTestId('verify-dialog')).toBeVisible();
    await page.getByTestId('verify-use-recovery').click();
    const dialog = page.getByTestId('recovery-dialog');
    await expect(dialog).toBeVisible();

    // AC-E5-3: a well-formed wrong key, then garbage
    const otherKey = await page.evaluate(async () => (await (window as any).__matrixPoc.security.getCryptoApi().createRecoveryKeyFromPassphrase()).encodedPrivateKey as string);
    await page.getByTestId('recovery-input').fill(otherKey);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-error')).toHaveText('That recovery key is not correct', { timeout: 15_000 });
    await expect(dialog).toBeVisible();
    await page.getByTestId('recovery-input').fill('definitely not a key');
    await expect(page.getByTestId('recovery-error'), 'the error clears as soon as the user types').toHaveCount(0);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-error')).toHaveText('Not a recovery key', { timeout: 15_000 });
    expect((await cryptoState(page)).status?.verified).toBe(false);

    // AC-E5-2: the right key, pasted without spaces
    await page.getByTestId('recovery-input').fill(recoveryKey.replace(/ /g, ''));
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
    await expectVerified(page);
    expect(await cryptoApiCall<boolean>(page, 'isCrossSigningReady')).toBe(true);
    expect(await cryptoApiCall<string>(page, 'getActiveSessionBackupVersion')).toBeTruthy();
    const restored = (await cryptoState(page)).recovery.lastRestore;
    expect(restored?.imported ?? 0, 'keys restored from backup').toBeGreaterThan(0);
    await closeDialog(page, 'recovery-dialog');

    // AC-E2-6: no reload, every placeholder flips within 10 s
    for (const [i, id] of ids.entries()) {
      await expect(row(page, id).getByTestId('message-body')).toHaveText(texts[i], { timeout: 10_000 });
    }
    await expect(messageList(page).getByTestId('message-undecryptable')).toHaveCount(0);

    // the key is not persisted by the app
    const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(ls.includes(recoveryKey.replace(/ /g, '')) || ls.includes(recoveryKey), 'recovery key in localStorage').toBe(false);

    // AC-E5-5: nothing offers a new key on an account with secret storage
    expect((await cryptoState(page)).hint).not.toBe('setup');
    const again = await page.evaluate(() => (window as any).__matrixPoc.security.store.getState().setupRecovery());
    expect(again, 'setupRecovery refuses when secret storage exists').toBeNull();
    expect(await defaultSecretStorageKey(U.token, U.userId)).toBe(defaultKeyId);
    await expect(page.getByTestId('setup-dialog')).toHaveCount(0);
  });

  test('AC-E4-3 + AC-E4-5 + AC-E4-7 + AC-E4-4 + AC-E4-6 SAS: mismatch and decline cancel; match verifies; reload keeps it', async ({ browser }) => {
    const C = await device(browser, U);
    const a = A.page;
    const c = C.page;
    await openRoom(a, U);
    // AC-E4-7 half: the incoming dialog must appear even with the thread panel open on A
    await openThreadFromMessage(a, ids[0]);

    // mismatch
    await expect(banner(c)).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
    await c.getByTestId('security-banner-action').click();
    await c.getByTestId('verify-use-device').click();
    await expect(c.getByTestId('verify-dialog')).toHaveAttribute('data-phase', 'requested', { timeout: 10_000 });
    await expect(c.getByTestId('verify-waiting')).toBeVisible();
    const incoming = a.getByTestId('verify-dialog');
    await expect(incoming).toHaveAttribute('data-phase', 'incoming', { timeout: 10_000 });
    await expect(incoming).toHaveAttribute('data-direction', 'incoming');
    await a.getByTestId('verify-accept').click();
    await sameEmoji(a, c);
    await c.getByTestId('verify-mismatch').click();
    for (const p of [a, c]) await expect(p.getByTestId('verify-dialog')).toHaveAttribute('data-phase', /cancelled|error/, { timeout: 15_000 });
    await expect(c.getByTestId('verify-dialog')).toContainText(/match|cancel/i);
    expect((await cryptoState(c)).status?.verified).toBe(false);
    for (const p of [a, c]) await closeDialog(p, 'verify-dialog');
    await expect(banner(c), 'closing leaves the banner as it was').toHaveAttribute('data-need', 'verify');

    // decline
    await c.getByTestId('security-banner-action').click();
    await c.getByTestId('verify-use-device').click();
    await expect(a.getByTestId('verify-dialog')).toHaveAttribute('data-phase', 'incoming', { timeout: 10_000 });
    await a.getByTestId('verify-decline').click();
    await expect(c.getByTestId('verify-dialog')).toHaveAttribute('data-phase', /cancelled|error/, { timeout: 15_000 });
    for (const p of [a, c]) await closeDialog(p, 'verify-dialog');

    // match
    const emoji = await verifyBetween(a, c);
    expect(emoji).toHaveLength(7);
    await expectVerified(c);
    const cDevice = (await cryptoState(c)).status!.deviceId;
    const fromA = await a.evaluate(async ([uid, did]) => (await (window as any).__matrixPoc.security.getCryptoApi().getDeviceVerificationStatus(uid, did))?.crossSigningVerified ?? null, [U.userId, cDevice] as const);
    expect(fromA, "A sees C as cross-signed").toBe(true);
    await waitForCrypto(c, (s) => s.hint === null || s.hint === 'unlock', 'C hint after SAS is unlock or none');

    // AC-E4-6
    await c.reload();
    await expect(c.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await waitForStatus(c);
    await expectVerified(c);
    await expect(c.getByTestId('verify-dialog')).toHaveCount(0);
  });

  test('AC-E5-6 (part 2) a new device that unlocks reads all three; A keeps the same active backup after reload', async ({ browser }) => {
    const D = await device(browser, U);
    await openRoom(D.page, U);
    await unlockWith(D.page, recoveryKey);
    await closeDialog(D.page, 'recovery-dialog');
    for (const [i, id] of ids.entries()) await expect(row(D.page, id).getByTestId('message-body')).toHaveText(texts[i], { timeout: 15_000 });

    const version = await cryptoApiCall<string>(A.page, 'getActiveSessionBackupVersion');
    await A.page.reload();
    await expect(A.page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await waitForStatus(A.page);
    await expect.poll(() => cryptoApiCall<string>(A.page, 'getActiveSessionBackupVersion'), { timeout: 20_000 }).toBe(version);
  });

  test.fixme('AC-E4-2 wrong password shows setup-error and stays in auth', async () => {
    // Not reachable on a fresh account: the first cross-signing upload needs no UIA (spec v1.11, ARCHITECTURE
    // "First upload needs no UIA"), so setup never asks for a password. Only a reset asks, and the UI has no reset.
  });

  test.fixme('AC-E5-7 restoring banner while 50+ keys arrive (P1)', async () => {
    // Needs 50+ Megolm sessions in one account's backup; the sample script makes one session per run and its
    // device does not back up. Revisit with a key-generation helper.
  });
});

/* ================================================================== AC-E5-4 passphrase */

test('AC-E5-4 a passphrase-based recovery key unlocks a new device from the same input', async ({ browser }) => {
  const U = await freshAccount('qapass');
  const A = await device(browser, U);
  annotate('core-fallback', 'secret storage with a passphrase is created through the store (no passphrase option in the setup UI)');
  await setupViaStore(A.page, { passphrase: 'correct horse' });
  await openRoom(A.page, U);
  const t = `[qa] passphrase ${Date.now().toString(36)}`;
  await typeAndSend(A.page, t);
  const id = await settledEventId(rowByText(A.page, t), 20_000);
  await waitForCrypto(A.page, (s) => (s.backupRemaining ?? 1) === 0, 'backup upload done', 40_000);
  await A.close();

  const B = await device(browser, U);
  await openRoom(B.page, U);
  await expectUtd(B.page, id, 'locked-backup', 20_000);
  await unlockWith(B.page, 'correct horse');
  await expectVerified(B.page);
  await closeDialog(B.page, 'recovery-dialog');
  await expect(row(B.page, id).getByTestId('message-body')).toHaveText(t, { timeout: 15_000 });
});

/* ================================================================== regressions (Principal follow-ups 21179cb) */

test.describe('regressions', () => {
  test('AC-E4-1 current-user data-verified is "unknown" on an account with no cross-signing', async ({ page }) => {
    const u = await freshUser('qaunknown');
    await loginWith(page, { username: u.username, password: u.password, displayName: u.username });
    await waitForStatus(page);
    // BUG-14: the pill says "false" once status lands; AC-E4-1 says "unknown" until an identity exists.
    await expect(verifiedAttr(page)).toHaveAttribute('data-verified', 'unknown');
  });

  test('(c) a fresh user with no rooms still sees the security banner', async ({ page }) => {
    const u = await freshUser('qanorooms');
    await loginWith(page, { username: u.username, password: u.password, displayName: u.username });
    await waitForStatus(page);
    await expect(banner(page)).toBeVisible({ timeout: 15_000 });
    await expect(banner(page)).toHaveAttribute('data-need', 'setup');
  });

  test('BUG-16 each security dialog exposes its own close testid, and clicking it closes the dialog', async ({ page }) => {
    const u = await freshUser('qaclose');
    await loginWith(page, { username: u.username, password: u.password, displayName: u.username });
    await waitForStatus(page);
    // setup-dialog from the banner (fresh account -> `setup`).
    await expect(banner(page)).toHaveAttribute('data-need', 'setup', { timeout: 15_000 });
    await page.getByTestId('security-banner-action').click();
    // verify-dialog / recovery-dialog are opened the way Dev B's placeholder actions do (`openSecurityDialog`).
    const open = (kind: 'setup' | 'verify' | 'unlock') =>
      page.evaluate(async (k) => {
        const url = '/src/features/security/index.ts'; // Vite dev serves the module; a variable keeps tsc out of it
        const m = (await import(/* @vite-ignore */ url)) as { openSecurityDialog(kind: string): void };
        m.openSecurityDialog(k);
      }, kind);
    for (const [kind, id] of [['setup', 'setup'], ['verify', 'verify'], ['unlock', 'recovery']] as const) {
      if (kind !== 'setup') await open(kind);
      const dialog = page.getByTestId(`${id}-dialog`);
      await expect(dialog).toBeVisible();
      const close = dialog.getByTestId(`${id}-close`);
      await expect(close, `${id}-dialog has ${id}-close`).toBeVisible();
      await close.click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    }
    await expect(banner(page)).toHaveAttribute('data-need', 'setup'); // closing changed nothing (AC-E4-5)
  });

  test('(d) unlockWithRecoveryKey reports errorKind invalid for garbage and wrong for another well-formed key', async ({ page }) => {
    const u = await freshUser('qaerrkind');
    await loginWith(page, { username: u.username, password: u.password, displayName: u.username });
    await waitForStatus(page);
    await setupViaStore(page);
    expect(await unlockViaStore(page, 'x')).toBe(false);
    expect((await cryptoState(page)).recovery.errorKind).toBe('invalid');
    const other = await page.evaluate(async () => (await (window as any).__matrixPoc.security.getCryptoApi().createRecoveryKeyFromPassphrase()).encodedPrivateKey as string);
    expect(await unlockViaStore(page, other)).toBe(false);
    expect((await cryptoState(page)).recovery.errorKind).toBe('wrong');
  });

  test('(e) a second incoming request after the first was cancelled tracks the second device', async ({ page, browser }) => {
    const U = await freshAccount('qaseq');
    await loginWith(page, U.acct);
    await waitForStatus(page);
    await setupViaStore(page);
    await waitForCrypto(page, (s) => !!s.status?.verified, 'A verified after setup');
    const store = (p: Page, action: string) => p.evaluate((a) => (window as any).__matrixPoc.security.store.getState()[a](), action);

    const X = await device(browser, U);
    const xId = (await cryptoState(X.page)).status!.deviceId;
    await store(X.page, 'startSelfVerification');
    await waitForCrypto(page, (s) => s.verification?.stage === 'requested' && !s.verification.initiatedByMe, 'first incoming request', 20_000);
    expect((await cryptoState(page)).verification?.otherDeviceId).toBe(xId);
    await store(X.page, 'cancelVerification');
    await waitForCrypto(page, (s) => s.verification?.stage === 'cancelled', 'first request cancelled on A', 20_000);
    await X.close();

    const Y = await device(browser, U);
    const yId = (await cryptoState(Y.page)).status!.deviceId;
    await store(Y.page, 'startSelfVerification');
    await waitForCrypto(page, (s) => s.verification?.stage === 'requested' && s.verification.otherDeviceId === yId, 'second incoming request tracks Y', 20_000);
    expect(yId).not.toBe(xId);
    await store(page, 'cancelVerification');
  });

  test('(f) secret storage without cross-signing (bootstrapped through the hook) gives the unlock hint', async ({ page }) => {
    const u = await freshUser('qassss');
    await loginWith(page, { username: u.username, password: u.password, displayName: u.username });
    await waitForStatus(page);
    await page.evaluate(async () => {
      const api = (window as any).__matrixPoc.security.getCryptoApi();
      const key = await api.createRecoveryKeyFromPassphrase();
      await api.bootstrapSecretStorage({ createSecretStorageKey: async () => key, setupNewSecretStorage: true });
    });
    expect(await hasCrossSigning(u.token, u.userId)).toBe(false);
    const s = await waitForCrypto(page, (st) => st.hint === 'unlock', 'hint === unlock', 20_000);
    expect(s.status?.hasCrossSigningKeys).toBe(false);
    expect(s.status?.secretStorageReady).toBe(true);
  });

  test('SAS via the store: both devices compute the same 7 emoji (core half of AC-E4-3)', async ({ page, browser }) => {
    const U = await freshAccount('qasas');
    await loginWith(page, U.acct);
    await waitForStatus(page);
    await setupViaStore(page);
    await waitForCrypto(page, (s) => !!s.status?.verified, 'A verified after setup');
    const N = await device(browser, U);
    const r = await verifyViaStore(page, N.page);
    expect(r.emojiNew).toHaveLength(7);
    expect(r.emojiNew).toEqual(r.emojiVerified);
    await waitForCrypto(N.page, (s) => !!s.status?.verified, 'new device verified', 30_000);
  });
});
