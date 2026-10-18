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
 *
 * Part regressions (regressions) of the former `e2ee-security.spec.ts`, split (issue #2, docs/PERF_PLAN.md) so the
 * two halves can run on different Playwright workers; tests moved verbatim. Other half: `e2ee-security-chain.spec.ts`.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { annotate } from './fixtures/state.ts';
import { createForeignKeyBackup, createRoom, freshUser, hasCrossSigning, keyBackup, masterKeyId, type Credentials } from './fixtures/e2ee-api.ts';
import {
  banner,
  cryptoApiCall,
  cryptoState,
  e2eeAfterEach,
  loginWith,
  secondContext,
  setupViaStore,
  unlockViaStore,
  verifyViaStore,
  waitForCrypto,
  waitForStatus,
  type Account,
  type SecondContext,
} from './fixtures/e2ee.ts';

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

async function device(browser: Browser, u: FreshAccount, keep = false): Promise<SecondContext> {
  const c = await secondContext(browser, u.acct, { keep });
  await waitForStatus(c.page);
  return c;
}

const verifiedAttr = (page: Page) => page.getByTestId('current-user');

/* ================================================================== regressions (Principal follow-ups 21179cb) */

test.describe('regressions', () => {
  test('AC-E4-1 current-user data-verified is "unknown" on an account with no cross-signing', async ({ page }) => {
    const u = await freshUser('qaunknown');
    await loginWith(page, { username: u.username, password: u.password, displayName: u.username });
    await waitForStatus(page);
    // BUG-14 regression (61e6cef): "unknown" until the account has an identity, not "false".
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

  /* ---------------------------------------------------------------- review B1: setup is never destructive */

  test('B1a fresh device on an account with an identity but no secret storage: never `setup`; a forced setup creates no identity', async ({ page, browser }) => {
    const U = await freshAccount('qab1a');
    // Device A: cross-signing only (first upload needs no UIA), no secret storage, no backup.
    const A = await device(browser, U);
    await A.page.evaluate(async () => {
      const api = (window as any).__matrixPoc.security.getCryptoApi();
      await api.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (makeRequest: (a: unknown) => Promise<unknown>) => void (await makeRequest(null)) });
    });
    const master = await masterKeyId(U.token, U.userId);
    expect(master, 'A published an identity').toBeTruthy();
    await A.close();

    await loginWith(page, U.acct);
    await waitForStatus(page);
    // The banner never offers setup on an account that has an identity (sampled for ~5 s).
    const needs = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const n = await banner(page).getAttribute('data-need', { timeout: 500 }).catch(() => null);
      if (n) needs.add(n);
      await page.waitForTimeout(500);
    }
    expect([...needs], 'banner needs seen').not.toContain('setup');

    // Forced open anyway: setup-start must not create an identity (or a backup).
    await page.evaluate(async () => {
      const url = '/src/features/security/index.ts'; // Vite dev serves the module; a variable keeps tsc out of it
      const m = (await import(/* @vite-ignore */ url)) as { openSecurityDialog(kind: string): void };
      m.openSecurityDialog('setup');
    });
    const setup = page.getByTestId('setup-dialog');
    const recovery = page.getByTestId('recovery-dialog');
    await expect(setup.or(recovery)).toBeVisible({ timeout: 10_000 });
    if (await setup.isVisible()) {
      await page.getByTestId('setup-start').click();
      await expect(page.getByTestId('setup-error').or(recovery)).toBeVisible({ timeout: 30_000 });
      if (await page.getByTestId('setup-error').isVisible()) {
        await expect(page.getByTestId('setup-error')).toHaveText('This account already has encryption set up elsewhere. Verify this device from your other device instead.');
      }
    }
    await expect(page.getByTestId('setup-key'), 'no new recovery key was shown').toHaveCount(0);
    expect(await masterKeyId(U.token, U.userId), 'the master key on the server is unchanged').toBe(master);
    expect(await keyBackup(U.token), 'no backup was created').toBeNull();
    expect((await cryptoState(page)).status?.verified, 'this device is not verified by a new identity').toBe(false);
  });

  test('B1b a setup on an account that already has a server backup keeps that backup version', async ({ page }) => {
    const U = await freshAccount('qab1b');
    await loginWith(page, U.acct);
    await waitForStatus(page);
    // This device holds the identity (cross-signing only, no secret storage) ...
    await page.evaluate(async () => {
      const api = (window as any).__matrixPoc.security.getCryptoApi();
      await api.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (makeRequest: (a: unknown) => Promise<unknown>) => void (await makeRequest(null)) });
    });
    const master = await masterKeyId(U.token, U.userId);
    // ... and the server already has a backup this device does not use (made by another client).
    const version = await createForeignKeyBackup(U.token);
    await waitForCrypto(page, (s) => !!s.status?.verified, 'this device is verified by its own identity', 20_000);
    expect(await cryptoApiCall<string | null>(page, 'getActiveSessionBackupVersion'), 'this device is not backing up to it').toBeNull();
    // What the SDK reports before the setup (its server-backup check ran at startup, before this backup existed).
    const seen = await page.evaluate(async () => ((await (window as any).__matrixPoc.security.getCryptoApi().getKeyBackupInfo()) as { version?: string } | null)?.version ?? null);
    const seenNote = `server backup v${version}; getKeyBackupInfo() on this device before setup: ${seen === null ? 'null' : `v${seen}`}`;
    annotate('B1b', seenNote);
    console.log(`[B1b] ${seenNote}`);

    // Non-reset setup through the UI (forced open: the banner says unlock for this state).
    await page.evaluate(async () => {
      const url = '/src/features/security/index.ts';
      const m = (await import(/* @vite-ignore */ url)) as { openSecurityDialog(kind: string): void };
      m.openSecurityDialog('setup');
    });
    await expect(page.getByTestId('setup-dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('setup-start').click();
    await expect(page.getByTestId('setup-key').or(page.getByTestId('setup-error'))).toBeVisible({ timeout: 30_000 });
    // Whatever the dialog ends in, the server backup is the same version (never deleted / replaced).
    expect((await keyBackup(U.token))?.version, 'same server backup version').toBe(version);
    expect(await masterKeyId(U.token, U.userId), 'same identity').toBe(master);
  });
});
