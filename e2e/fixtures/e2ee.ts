/**
 * Phase 5 (QA-24) browser helpers for the E2EE specs.
 *
 * Every login is a **new device** with its own Rust crypto store (IndexedDB `matrix-poc-crypto:<user>:<device>`),
 * and every Playwright context has its own IndexedDB, so "two devices" = two contexts (`secondContext`).
 *
 * Two levels, on purpose:
 *  - **core** helpers drive the security store through the dev hook (`window.__matrixPoc.security.store`):
 *    `setupViaStore`, `verifyViaStore`, `unlockViaStore`, `cryptoState`, `eventState`. They need only the
 *    Principal's core, so the chains in the specs run before Dev A's dialogs exist.
 *  - **UI** helpers drive Dev A's dialogs by testid: `setUpEncryption`, `verifyBetween`, `unlockWith`. The `*Auto`
 *    variants use the UI when its testids are in `src/` and fall back to the store otherwise (annotated
 *    `core-fallback`), so a spec upgrades itself to the real UI the moment the code lands.
 *  - `requireUi(owner, ...testids)` skips a UI-only criterion with "waiting on Dev A/B: <testids>" until the
 *    testids appear in `src/` (a source scan, not a DOM probe, so a broken component still fails red).
 *
 * `status` is null until the first /sync + /keys/query (~1 s after `app-shell`): `waitForStatus` before reading it.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { DISPLAY_NAMES, PASSWORD, type UserKey } from './seed.ts';
import { e2eeKeysFile, workerOrigin } from './pool.ts';
import { SESSION_STORAGE_KEY, statusDiagnosis } from './auth.ts';
import { noteServerUse } from './run-log.ts';
import { annotate } from './state.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
export const CRYPTO_DB_PREFIX = 'matrix-poc-crypto:';
const SHELL_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------------------------- UI availability

let sourceCache: string | null = null;
function sourceText(): string {
  if (sourceCache !== null) return sourceCache;
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '__dev__' || name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(name)) parts.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(REPO, 'src'));
  sourceCache = parts.join('\n');
  return sourceCache;
}

/** Testids (literal strings) not yet present anywhere under `src/`. */
export function missingTestIds(...testids: string[]): string[] {
  const src = sourceText();
  return testids.filter((t) => !src.includes(`'${t}'`) && !src.includes(`"${t}"`) && !src.includes(`\`${t}`));
}

export function uiLanded(...testids: string[]): boolean {
  return missingTestIds(...testids).length === 0;
}

export type Owner = 'Dev A' | 'Dev B' | 'Principal';

/** Skips the current test until every testid is in `src/` (so the report says who it waits on). */
export function requireUi(owner: Owner, ...testids: string[]): void {
  const missing = missingTestIds(...testids);
  test.skip(missing.length > 0, `waiting on ${owner}: ${missing.join(', ')} not in src/ yet`);
}

/** Soft check for a UI half inside a core test: runs `fn` when landed, else records a `ui-pending` annotation. */
export async function uiHalf(owner: Owner, testids: string[], fn: () => Promise<void>): Promise<boolean> {
  const missing = missingTestIds(...testids);
  if (missing.length) {
    annotate('ui-pending', `${owner}: ${missing.join(', ')} not in src/ yet; UI half not asserted`);
    return false;
  }
  await fn();
  return true;
}

// ---------------------------------------------------------------------------------------------- login / contexts

export interface Account {
  username: string;
  password?: string;
  /** What `current-user` shows (seeded display name, else the localpart). */
  displayName?: string;
}

export function accountOf(user: UserKey | Account): Account {
  return typeof user === 'string' ? { username: user, password: PASSWORD, displayName: DISPLAY_NAMES[user] } : user;
}

export interface LoginTrace {
  /** Every `app-loading[data-stage]` value seen during the boot (AC-E1-1). */
  stages(): Promise<string[]>;
}

/** Records `app-loading[data-stage]` values from the first paint (install before `goto`). */
export async function traceLoadingStages(page: Page): Promise<LoginTrace> {
  await page.addInitScript(() => {
    const w = window as unknown as { __qaStages?: string[] };
    w.__qaStages = [];
    const seen = (): void => {
      const el = document.querySelector('[data-testid="app-loading"]');
      const s = el?.getAttribute('data-stage');
      if (s && w.__qaStages![w.__qaStages!.length - 1] !== s) w.__qaStages!.push(s);
    };
    new MutationObserver(seen).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-stage'] });
  });
  return { stages: () => page.evaluate(() => (window as unknown as { __qaStages?: string[] }).__qaStages ?? []) };
}

/** Logs any account in through the real login form and waits for the desktop shell (generic `loginAs`). */
export async function loginWith(page: Page, user: UserKey | Account): Promise<number> {
  noteServerUse();
  const acct = accountOf(user);
  if (/^https?:/i.test(page.url())) {
    await page.evaluate((key) => window.localStorage.removeItem(key), SESSION_STORAGE_KEY).catch(() => undefined);
  }
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible({ timeout: SHELL_TIMEOUT });
  await page.getByTestId('login-username').fill(acct.username);
  await page.getByTestId('login-password').fill(acct.password ?? PASSWORD);
  const t0 = Date.now();
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: SHELL_TIMEOUT });
  const elapsed = Date.now() - t0;
  await expect(page.getByTestId('current-user')).toContainText(acct.displayName ?? acct.username, { timeout: SHELL_TIMEOUT });
  await expect(page.getByTestId('space-rail')).toBeVisible({ timeout: SHELL_TIMEOUT });
  return elapsed;
}

/** Best-effort logout (wipes the crypto store, deletes the device server-side). */
export async function logoutQuietly(page: Page): Promise<void> {
  try {
    if (page.isClosed()) return;
    const btn = page.getByTestId('logout-button');
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      await expect(page.getByTestId('login-form')).toBeVisible({ timeout: 15_000 });
    }
  } catch {
    /* the test already failed; do not mask it */
  }
}

export interface SecondContext {
  context: BrowserContext;
  page: Page;
  /** Logs out (device deleted, store wiped) and closes the context. Idempotent. */
  close(): Promise<void>;
}

/** A second browser context (separate IndexedDB = separate device), logged in. */
export async function secondContext(browser: Browser, user: UserKey | Account, opts: { baseURL?: string; login?: boolean; keep?: boolean } = {}): Promise<SecondContext> {
  const baseURL = opts.baseURL ?? workerOrigin();
  const context = await browser.newContext({ ...devices['Desktop Chrome'], baseURL });
  const page = await context.newPage();
  if (opts.login !== false) await loginWith(page, user);
  let closed = false;
  const handle: SecondContext = {
    context,
    page,
    async close() {
      if (closed) return;
      closed = true;
      open.delete(handle);
      await logoutQuietly(page);
      await context.close().catch(() => undefined);
    },
  };
  if (!opts.keep) open.add(handle); // `keep`: survives e2eeAfterEach (a device that spans several tests)
  return handle;
}

const open = new Set<SecondContext>();

/**
 * `afterEach` for the E2EE specs: on failure, screenshots `page` and every second context still open (before any
 * logout, so the picture is the failure, not the login form), then logs everything out.
 */
export async function e2eeAfterEach(page: Page, info: import('@playwright/test').TestInfo): Promise<void> {
  const failed = info.status !== info.expectedStatus;
  const shoot = async (p: Page, name: string): Promise<void> => {
    if (!failed || p.isClosed()) return;
    const path = info.outputPath(`${name}.png`);
    if (await p.screenshot({ path }).then(() => true).catch(() => false)) await info.attach(name, { path, contentType: 'image/png' });
  };
  await shoot(page, 'page-at-failure');
  let n = 0;
  for (const c of [...open]) {
    n += 1;
    await shoot(c.page, `second-context-${n}-at-failure`);
    await c.close();
  }
  await logoutQuietly(page);
}

// ---------------------------------------------------------------------------------------------- hook reads

export interface OwnDeviceStatus {
  deviceId: string;
  verified: boolean;
  hasCrossSigningKeys: boolean;
  crossSigningReady: boolean;
  secretStorageReady: boolean;
  defaultKeyId: string | null;
  backup: { version: string | null; trusted: boolean; keyCached: boolean; enabled: boolean };
}

export interface CryptoSnapshot {
  cryptoReady: boolean;
  cryptoError: string | null;
  status: OwnDeviceStatus | null;
  hint: 'setup' | 'verify' | 'unlock' | null;
  verification: {
    stage: string;
    initiatedByMe: boolean;
    isSelf: boolean;
    otherUserId: string;
    otherDeviceId?: string;
    sas: { emoji: [string, string][] } | null;
    error: string | null;
  } | null;
  recovery: { busy: string | null; errorKind?: string; progress: { imported: number; total: number } | null; lastRestore: { imported: number; total: number } | null; error: string | null };
  prompt: { kind: string; message: string } | null;
  newRecoveryKey: string | null;
  backupRemaining: number | null;
}

/** `useSecurityStore.getState()` as plain data (the dev hook; `__matrixPoc.security.store`). */
export async function cryptoState(page: Page): Promise<CryptoSnapshot> {
  return page.evaluate(() => {
    const hook = (window as any).__matrixPoc?.security;
    if (!hook) throw new Error('window.__matrixPoc.security missing (dev build only)');
    const s = hook.store.getState();
    return JSON.parse(
      JSON.stringify({
        cryptoReady: s.cryptoReady,
        cryptoError: s.cryptoError,
        status: s.status,
        hint: s.hint,
        verification: s.verification,
        recovery: s.recovery,
        prompt: s.prompt,
        newRecoveryKey: s.newRecoveryKey,
        backupRemaining: s.backupRemaining ?? null,
      }),
    );
  });
}

/** Waits for the first status snapshot (null until ~1 s after app-shell) and returns the state. */
export async function waitForStatus(page: Page, timeout = 30_000): Promise<CryptoSnapshot & { status: OwnDeviceStatus }> {
  try {
    await expect
      .poll(async () => (await cryptoState(page)).status !== null, { timeout, message: 'useSecurityStore.status never arrived' })
      .toBe(true);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n\nstatus diagnosis: ${await statusDiagnosis(page)}`);
  }
  return (await cryptoState(page)) as CryptoSnapshot & { status: OwnDeviceStatus };
}

/** Re-reads the status (`store.refresh()`) and waits until `predicate` holds. */
export async function waitForCrypto(page: Page, predicate: (s: CryptoSnapshot) => boolean, message: string, timeout = 30_000): Promise<CryptoSnapshot> {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => (window as any).__matrixPoc.security.store.getState().refresh()).catch(() => undefined);
        return predicate(await cryptoState(page));
      },
      { timeout, message, intervals: [500, 1000, 1500] },
    )
    .toBe(true);
  return cryptoState(page);
}

export interface StoredSessionJson {
  userId: string;
  deviceId: string;
  accessToken: string;
  baseUrl: string;
}

export async function storedSession(page: Page): Promise<StoredSessionJson | null> {
  const raw = await page.evaluate((k) => window.localStorage.getItem(k), SESSION_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as StoredSessionJson) : null;
}

/** `indexedDB.databases()` names. */
export async function dbNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => ((await indexedDB.databases()) ?? []).map((d) => d.name ?? ''));
}

export async function cryptoDbNames(page: Page): Promise<string[]> {
  return (await dbNames(page)).filter((n) => n.startsWith('matrix-poc-crypto:'));
}

/** AC-E1-3/4: the crypto store is gone (the delete can lag ~17 s behind the login form; poll up to 30 s). */
export async function expectCryptoWiped(page: Page, timeout = 30_000): Promise<void> {
  await expect
    .poll(() => cryptoDbNames(page), { timeout, intervals: [500, 1000, 2000], message: 'a matrix-poc-crypto: IndexedDB survived logout' })
    .toEqual([]);
}

/** Calls an async function on the security hook (`__matrixPoc.security[name](...args)`). */
export async function hookCall<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([fn, a]) => {
      const hook = (window as any).__matrixPoc.security;
      const out = await hook[fn as string](...(a as unknown[]));
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    },
    [name, args] as const,
  ) as Promise<T>;
}

/** Calls a CryptoApi method (`__matrixPoc.security.getCryptoApi()[name](...args)`) and returns plain data. */
export async function cryptoApiCall<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([fn, a]) => {
      const api = (window as any).__matrixPoc.security.getCryptoApi();
      if (!api) throw new Error('crypto not ready');
      const out = await api[fn as string](...(a as unknown[]));
      return out === undefined || out === null ? null : JSON.parse(JSON.stringify(out, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : typeof v === 'bigint' ? Number(v) : v)));
    },
    [name, args] as const,
  ) as Promise<T>;
}

export interface EventState {
  found: boolean;
  wireType?: string;
  type?: string;
  sender?: string;
  decryption?: { status: string; code?: string; message?: string; historical?: boolean };
  text?: string;
  msgtype?: string;
  content?: Record<string, any>;
  preview?: string;
  redacted?: boolean;
}

/** The app's own view of one event (client cache + the Phase 5 display helpers). */
export async function eventState(page: Page, roomId: string, eventId: string): Promise<EventState> {
  return page.evaluate(
    ([r, id]) => {
      const w = (window as any).__matrixPoc;
      const room = w.getClient()?.getRoom(r);
      const ev = room?.findEventById(id) ?? room?.getThreads?.().flatMap((t: any) => t.timeline).find((e: any) => e.getId() === id);
      if (!ev) return { found: false };
      const body = w.utils.getDisplayBody(ev);
      return JSON.parse(
        JSON.stringify({
          found: true,
          wireType: ev.getWireType(),
          type: ev.getType(),
          sender: ev.getSender(),
          decryption: w.utils.getDecryptionState(ev),
          text: body?.text,
          msgtype: body?.msgtype,
          content: ev.getContent(),
          preview: w.utils.previewText(ev),
          redacted: ev.isRedacted(),
        }),
      );
    },
    [roomId, eventId] as const,
  );
}

export async function waitForEventState(page: Page, roomId: string, eventId: string, predicate: (s: EventState) => boolean, message: string, timeout = 15_000): Promise<EventState> {
  let last: EventState = { found: false };
  await expect
    .poll(async () => predicate((last = await eventState(page, roomId, eventId))), { timeout, message: () => `${message} (last: ${JSON.stringify(last).slice(0, 300)})` } as never)
    .toBe(true);
  return last;
}

/** AC-E7-3: imports this worker's keys file (`seed/e2ee-keys.json`, or a per-worker copy in parallel runs) through the dev hook. */
export async function importSampleKeys(page: Page): Promise<number> {
  const json = readFileSync(e2eeKeysFile(), 'utf8');
  await page.evaluate((j) => (window as any).__matrixPoc.security.importRoomKeys(j), json);
  return (JSON.parse(json) as unknown[]).length;
}

// ---------------------------------------------------------------------------------------------- sample script

export interface SampleResult {
  roomId: string;
  eventIds: string[];
}

/** `scripts/send-encrypted-sample.mjs` (PRIN-22): a short-lived Node device posts encrypted texts, then logs out. */
export function runSample(opts: { as?: string; room?: string; count?: number; image?: boolean } = {}): SampleResult {
  const args = ['scripts/send-encrypted-sample.mjs', '--as', opts.as ?? 'bob', '--room', opts.room ?? '#vault:localhost', '--count', String(opts.count ?? 1)];
  if (!opts.image) args.push('--no-image');
  const out = execFileSync('node', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
  const json = out.slice(out.indexOf('{'));
  return JSON.parse(json) as SampleResult;
}

// ---------------------------------------------------------------------------------------------- core flows (store)

/** First-time setup through the store (`setupRecovery`), answering a password prompt if UIA asks. Returns the key. */
export async function setupViaStore(page: Page, opts: { passphrase?: string; password?: string } = {}): Promise<string> {
  const key = await page.evaluate(
    async ([passphrase, password]) => {
      const store = (window as any).__matrixPoc.security.store;
      const off = store.subscribe((s: any) => {
        if (s.prompt?.kind === 'password') setTimeout(() => store.getState().answerPrompt(password), 0);
      });
      try {
        return await store.getState().setupRecovery(passphrase ? { passphrase } : {});
      } finally {
        off();
      }
    },
    [opts.passphrase ?? null, opts.password ?? PASSWORD] as const,
  );
  if (!key) throw new Error(`setupRecovery returned null: ${(await cryptoState(page)).recovery.error}`);
  await page.evaluate(() => (window as any).__matrixPoc.security.store.getState().dismissRecoveryKey());
  return key;
}

/** Unlock through the store (`unlockWithRecoveryKey`). Resolves with the store's boolean. */
export async function unlockViaStore(page: Page, input: string): Promise<boolean> {
  return page.evaluate(async (k) => (window as any).__matrixPoc.security.store.getState().unlockWithRecoveryKey(k), input);
}

async function waitStage(page: Page, stage: string, label: string, timeout = 20_000): Promise<CryptoSnapshot> {
  return waitForCryptoNoRefresh(page, (s) => s.verification?.stage === stage, `${label}: verification.stage -> ${stage}`, timeout);
}

async function waitForCryptoNoRefresh(page: Page, predicate: (s: CryptoSnapshot) => boolean, message: string, timeout: number): Promise<CryptoSnapshot> {
  let last: CryptoSnapshot | null = null;
  await expect
    .poll(async () => predicate((last = await cryptoState(page))), { timeout, intervals: [250, 500, 1000], message: () => `${message} (last: ${JSON.stringify(last?.verification)})` } as never)
    .toBe(true);
  return last!;
}

export interface SasResult {
  emojiNew: [string, string][];
  emojiVerified: [string, string][];
}

/**
 * SAS self-verification through the store: `newPage` (unverified) requests, `verifiedPage` accepts, both reach `sas`
 * with identical emoji, both confirm (or `outcome: 'mismatch'` / `'decline'`).
 */
export async function verifyViaStore(verifiedPage: Page, newPage: Page, outcome: 'match' | 'mismatch' | 'decline' = 'match'): Promise<SasResult> {
  const store = (p: Page, action: string): Promise<unknown> => p.evaluate((a) => (window as any).__matrixPoc.security.store.getState()[a](), action);
  for (const p of [verifiedPage, newPage]) await store(p, 'dismissVerification');
  await store(newPage, 'startSelfVerification');
  const incoming = await waitForCryptoNoRefresh(verifiedPage, (s) => !!s.verification && !s.verification.initiatedByMe && s.verification.stage === 'requested', 'incoming request on the verified device', 20_000);
  expect(incoming.verification!.isSelf).toBe(true);
  if (outcome === 'decline') {
    await store(verifiedPage, 'cancelVerification');
    await waitStage(newPage, 'cancelled', 'requester after decline');
    return { emojiNew: [], emojiVerified: [] };
  }
  await store(verifiedPage, 'acceptVerification');
  const a = await waitStage(newPage, 'sas', 'requester');
  const b = await waitStage(verifiedPage, 'sas', 'accepter');
  const result = { emojiNew: a.verification!.sas!.emoji, emojiVerified: b.verification!.sas!.emoji };
  if (outcome === 'mismatch') {
    await store(newPage, 'mismatchSas');
    await waitStage(newPage, 'cancelled', 'requester after mismatch');
    await waitStage(verifiedPage, 'cancelled', 'accepter after mismatch');
    return result;
  }
  await Promise.all([store(newPage, 'confirmSas'), store(verifiedPage, 'confirmSas')]);
  await waitStage(newPage, 'done', 'requester', 30_000);
  await waitStage(verifiedPage, 'done', 'accepter', 30_000);
  return result;
}

// ---------------------------------------------------------------------------------------------- UI flows (Dev A)

export const SETUP_UI = ['security-banner', 'security-banner-action', 'setup-dialog', 'setup-key', 'setup-confirm'];
export const VERIFY_UI = ['verify-dialog', 'verify-use-device', 'verify-accept', 'verify-emoji-item', 'verify-match', 'verify-done'];
export const RECOVERY_UI = ['recovery-dialog', 'recovery-input', 'recovery-submit', 'recovery-done'];

export const banner = (page: Page): Locator => page.getByTestId('security-banner');

/** Drives `setup-dialog` from the banner and returns the key read from `setup-key` (not the clipboard). */
export async function setUpEncryption(page: Page, password = PASSWORD): Promise<string> {
  await expect(banner(page)).toHaveAttribute('data-need', 'setup', { timeout: 20_000 });
  await page.getByTestId('security-banner-action').click();
  const dialog = page.getByTestId('setup-dialog');
  await expect(dialog).toBeVisible();
  const start = page.getByTestId('setup-start');
  if (await start.isVisible().catch(() => false)) await start.click();
  const key = page.getByTestId('setup-key');
  const pwd = page.getByTestId('setup-password');
  await expect(key.or(pwd)).toBeVisible({ timeout: 30_000 });
  if (await pwd.isVisible()) {
    await pwd.fill(password);
    await page.getByTestId('setup-password-submit').click();
  }
  await expect(key).toBeVisible({ timeout: 30_000 });
  const text = (await key.innerText()).trim();
  const copy = page.getByTestId('setup-copy');
  if (await copy.isVisible().catch(() => false)) await copy.click().catch(() => undefined);
  await expect(page.getByTestId('setup-confirm')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('setup-confirm').click();
  await expect(dialog).toBeHidden({ timeout: 10_000 }).catch(() => closeDialog(page, 'setup-dialog'));
  return text;
}

/** Drives both `verify-dialog`s: `newPage` from its banner, `verifiedPage` accepts; asserts identical emoji. */
export async function verifyBetween(verifiedPage: Page, newPage: Page): Promise<string[]> {
  await expect(banner(newPage)).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
  await newPage.getByTestId('security-banner-action').click();
  await newPage.getByTestId('verify-use-device').click();
  await expect(newPage.getByTestId('verify-dialog')).toHaveAttribute('data-phase', 'requested', { timeout: 10_000 });
  const incoming = verifiedPage.getByTestId('verify-dialog');
  await expect(incoming).toHaveAttribute('data-phase', 'incoming', { timeout: 10_000 });
  await verifiedPage.getByTestId('verify-accept').click();
  const emoji = await sameEmoji(verifiedPage, newPage);
  await newPage.getByTestId('verify-match').click();
  await verifiedPage.getByTestId('verify-match').click();
  await expect(newPage.getByTestId('verify-done')).toBeVisible({ timeout: 30_000 });
  await expect(verifiedPage.getByTestId('verify-done')).toBeVisible({ timeout: 30_000 });
  for (const p of [newPage, verifiedPage]) await closeDialog(p, 'verify-dialog');
  return emoji;
}

/** Closes a security dialog: `<kind>-close` per the registry, else the shared `dialog-close` (BUG-16). */
export async function closeDialog(page: Page, dialogTestId: string): Promise<void> {
  const dialog = page.getByTestId(dialogTestId);
  if (!(await dialog.isVisible().catch(() => false))) return;
  const own = dialog.getByTestId(dialogTestId.replace('-dialog', '-close'));
  const shared = dialog.getByTestId('dialog-close');
  if (await own.count()) await own.first().click();
  else if (await shared.count()) await shared.last().click();
  else await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden({ timeout: 5_000 });
}

/** Both dialogs in `sas` with 7 identical emoji; returns them. */
export async function sameEmoji(a: Page, b: Page): Promise<string[]> {
  for (const p of [a, b]) {
    await expect(p.getByTestId('verify-dialog')).toHaveAttribute('data-phase', 'sas', { timeout: 20_000 });
    await expect(p.getByTestId('verify-emoji-item')).toHaveCount(7);
  }
  const read = (p: Page): Promise<string[]> =>
    p.getByTestId('verify-emoji-item').evaluateAll((els) => els.map((e) => `${(e.textContent ?? '').trim()}|${e.getAttribute('data-name') ?? ''}`));
  const [ea, eb] = await Promise.all([read(a), read(b)]);
  expect(ea, 'both devices show the same 7 emoji').toEqual(eb);
  return ea;
}

/**
 * Opens `recovery-dialog` (banner action, or a direct `openSecurityDialog` via the placeholder), submits `input`.
 *
 * The key field is `recovery-input` in both the `form` and the `prompt` phase (the SDK asking for a secret-storage
 * key, only after E2's "I have a different recovery key"). `expectPhase` is where a successful submit ends: `done`
 * (default: verified + history restored) or `locked` (E2: verified, but the key backup cannot be opened, e.g. its
 * secret is under a non-default key: `recovery-locked`; an already-open E2, `locked` or `unavailable`, counts).
 * `expectSuccess: false` only submits.
 */
export async function unlockWith(page: Page, input: string, opts: { expectSuccess?: boolean; expectPhase?: 'done' | 'locked' } = {}): Promise<void> {
  const dialog = page.getByTestId('recovery-dialog');
  if (!(await dialog.isVisible().catch(() => false))) {
    const action = page.getByTestId('security-banner-action');
    await action.click();
    const viaRecovery = page.getByTestId('verify-use-recovery');
    if (await viaRecovery.isVisible({ timeout: 2000 }).catch(() => false)) await viaRecovery.click();
  }
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // `working` = a restore already runs by itself (SAS handed over the backup key); wait for it to settle.
  await expect(dialog).toHaveAttribute('data-phase', /^(form|prompt|done|locked|unavailable)$/, { timeout: 60_000 });
  const phase = await dialog.getAttribute('data-phase');
  if (phase === 'done') {
    annotate('auto-restore', 'recovery-dialog was already done (the backup key arrived with the verification)');
    return;
  }
  if (phase === 'locked' || phase === 'unavailable') {
    // E2: this session is verified but the backup cannot be opened; there is no key field here.
    expect(opts.expectPhase, `recovery-dialog opened in \`${phase}\` (session verified, backup locked) but the caller expected done`).toBe('locked');
    annotate('backup-locked', 'recovery-dialog was already locked (an earlier unlock verified the session)');
    return;
  }
  await page.getByTestId('recovery-input').fill(input);
  await page.getByTestId('recovery-submit').click();
  if (opts.expectSuccess === false) return;
  if (opts.expectPhase === 'locked') {
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 60_000 });
    await expect(page.getByTestId('recovery-locked')).toBeVisible();
  } else {
    await expect(page.getByTestId('recovery-done')).toBeVisible({ timeout: 60_000 });
  }
}

/**
 * Samples recovery-dialog[data-phase] and the store's pending prompt every 100 ms until stopped: a normal unlock
 * must never show the `prompt` phase nor register a recovery-key prompt ("One ask only").
 */
export function watchRecoveryPhases(page: Page): { phases: string[]; prompts: string[]; stop(): void } {
  const phases: string[] = [];
  const prompts: string[] = [];
  const timer = setInterval(() => {
    void page
      .evaluate(() => {
        const el = document.querySelector('[data-testid="recovery-dialog"]');
        return { phase: el?.getAttribute('data-phase') ?? null, prompt: (window as any).__matrixPoc?.security?.store.getState().prompt?.kind ?? null };
      })
      .then(({ phase, prompt }) => {
        if (phase && phases[phases.length - 1] !== phase) phases.push(phase);
        if (prompt && prompts[prompts.length - 1] !== prompt) prompts.push(prompt);
      })
      .catch(() => undefined);
  }, 100);
  return { phases, prompts, stop: () => clearInterval(timer) };
}

/** Imports the security feature module through Vite (dev only) and opens a dialog, like Dev B's placeholders do. */
export async function openSecurityDialog(page: Page, kind: 'setup' | 'verify' | 'unlock'): Promise<void> {
  await page.evaluate(async (k) => {
    const url = '/src/features/security/index.ts'; // Vite dev serves the module; a variable keeps tsc out of it
    const m = (await import(/* @vite-ignore */ url)) as { openSecurityDialog(kind: string): void };
    m.openSecurityDialog(k);
  }, kind);
}

/** UI when Dev A's dialogs exist, else the store (annotated). */
export async function setUpEncryptionAuto(page: Page, opts: { passphrase?: string } = {}): Promise<string> {
  if (!opts.passphrase && uiLanded(...SETUP_UI)) return setUpEncryption(page);
  annotate('core-fallback', opts.passphrase ? 'setup with a passphrase via the store (AC-E5-4 QA path)' : 'setup via the store: setup-dialog not in src/ yet (Dev A)');
  return setupViaStore(page, opts);
}

export async function verifyAuto(verifiedPage: Page, newPage: Page): Promise<void> {
  if (uiLanded(...VERIFY_UI)) {
    await verifyBetween(verifiedPage, newPage);
    return;
  }
  annotate('core-fallback', 'SAS via the store: verify-dialog not in src/ yet (Dev A)');
  const r = await verifyViaStore(verifiedPage, newPage);
  expect(r.emojiNew).toEqual(r.emojiVerified);
}

export async function unlockAuto(page: Page, input: string): Promise<void> {
  if (uiLanded(...RECOVERY_UI)) {
    await unlockWith(page, input);
    return;
  }
  annotate('core-fallback', 'unlock via the store: recovery-dialog not in src/ yet (Dev A)');
  expect(await unlockViaStore(page, input), `unlockWithRecoveryKey: ${(await cryptoState(page)).recovery.error}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------- rows (Dev B)

/** AC-E2-*: a row with the decrypted text in `message-body`. */
export async function expectDecryptedRow(page: Page, text: string, timeout = 10_000): Promise<Locator> {
  const r = page.getByTestId('message-list').getByTestId(/^message-[$~]/).filter({ has: page.getByTestId('message-body').filter({ hasText: text }) });
  await expect(r.first()).toBeVisible({ timeout });
  return r.first();
}

/** AC-E2-2: `message-undecryptable[data-reason]` replaces `message-body` in the row. */
export async function expectUtd(page: Page, eventId: string, reason: string | RegExp, timeout = 15_000): Promise<Locator> {
  const r = page.getByTestId(`message-${eventId}`);
  const p = r.getByTestId('message-undecryptable');
  await expect(p).toBeVisible({ timeout });
  await expect(p).toHaveAttribute('data-reason', reason);
  await expect(r.getByTestId('message-body')).toHaveCount(0);
  return p;
}

/** Element's recovery key format: 48 base58 chars in 12 groups of 4. */
export const RECOVERY_KEY_RE = /^([1-9A-HJ-NP-Za-km-z]{4} ){11}[1-9A-HJ-NP-Za-km-z]{4}$/;
