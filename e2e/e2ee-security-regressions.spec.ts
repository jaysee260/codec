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
import { createRoom, freshUser, hasCrossSigning, type Credentials } from './fixtures/e2ee-api.ts';
import {
  banner,
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
});
