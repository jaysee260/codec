/**
 * Login helpers (QA-1). Every test logs in fresh: Playwright gives each test its own browser
 * context, so localStorage starts empty and navigation lands on the store's default selection
 * (first space alphabetically = Acme HQ, first channel = #general — docs/ARCHITECTURE.md Deltas).
 */
import { expect, test, type Page } from '@playwright/test';
import { noteServerUse } from './run-log.ts';
import { DISPLAY_NAMES, HS_URL, PASSWORD, type UserKey } from './seed.ts';

/** localStorage keys the app owns (src/lib/matrix/config.ts). */
export const SESSION_STORAGE_KEY = 'matrix-poc.session';
export const NAV_STORAGE_KEY = 'nav.selection';

/** How long the shell may take to appear after submitting credentials (AC-SH-2 allows 10 s). */
const SHELL_TIMEOUT = 20_000;

export interface LoginOptions {
  password?: string;
  /** Skip waiting for the shell (used by the negative-path criteria). */
  expectFailure?: boolean;
  /** Pre-seed `nav.selection` so the app opens straight into a room. */
  selection?: { spaceId: string; roomId: string };
}

/**
 * Forgets the session this browser context is holding, so the next navigation lands on the login
 * form instead of restoring the previous user.
 *
 * The app persists `matrix-poc.session` and calls `restore()` on every page load (AC-SH-4), which is
 * correct — but it means a *second* `loginAs` inside one test (AC-B9-1 switches from alice to carol)
 * would silently keep the first user and never render `login-form`. A no-op before the first
 * navigation, when the context is still on `about:blank` and has no storage for the origin.
 */
async function dropStoredSession(page: Page): Promise<void> {
  if (!/^https?:/i.test(page.url())) return;
  await page
    .evaluate((key) => window.localStorage.removeItem(key), SESSION_STORAGE_KEY)
    .catch(() => undefined);
}

/**
 * Logs `user` in through the real login form and waits until the shell is interactive.
 * Safe to call more than once in a test: any session already held is dropped first.
 *
 *   await loginAs(page, 'alice');
 */
export async function loginAs(page: Page, user: UserKey = 'alice', opts: LoginOptions = {}): Promise<void> {
  noteServerUse();
  if (opts.selection) {
    // addInitScript runs before app code on every navigation in this context.
    const value = JSON.stringify({
      spaceId: opts.selection.spaceId,
      roomId: opts.selection.roomId,
      lastRoomBySpace: { [opts.selection.spaceId]: opts.selection.roomId },
    });
    await page.addInitScript(
      ([key, json]) => window.localStorage.setItem(key as string, json as string),
      [NAV_STORAGE_KEY, value],
    );
  }

  await dropStoredSession(page);
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await logoutEarlierTests();
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-password').fill(opts.password ?? PASSWORD);
  await page.getByTestId('login-submit').click();

  if (opts.expectFailure) return;

  const shell = page.getByTestId('app-shell');
  await expect(shell).toBeVisible({ timeout: SHELL_TIMEOUT });
  await rememberSession(page);

  // Who actually logged in — checked on both layouts. `toContainText` reads `textContent`, so it does
  // not need the element to be visible, which matters on phone: `current-user` is rendered inside the
  // *closed* `nav-drawer` (`visibility: hidden`).
  await expect(page.getByTestId('current-user')).toContainText(DISPLAY_NAMES[user], {
    timeout: SHELL_TIMEOUT,
  });

  // Phase 2: on phone the rail and the channel sidebar are inside that hidden drawer too, so waiting
  // for them to be *visible* would hang every mobile test. The phone shell's own "ready" signal is the
  // conversation column.
  if ((await shell.getAttribute('data-layout')) === 'phone') {
    await expect(page.getByTestId('channel-header')).toBeVisible({ timeout: SHELL_TIMEOUT });
    await expect(page.getByTestId('message-list')).toBeVisible({ timeout: SHELL_TIMEOUT });
    await settleSecurityBanner(page);
    return;
  }

  // The rail is the last thing to paint once the room store has done its first recompute.
  await expect(page.getByTestId('space-rail')).toBeVisible();
  await settleSecurityBanner(page);
}

/**
 * BUG-21: every `loginAs` creates a device, and closing the context does not log it out. Since Phase 5 each one
 * publishes device keys, so alice piled up ~800 and every login, `/keys/query` and room-key share got slower. The
 * session of each login is remembered here and logged out by the first `loginAs` of a *later* test (never one from
 * the running test, whose other pages may still use it).
 */
const sessionsToLogOut: { testId: string; token: string }[] = [];

function currentTestId(): string {
  try {
    return test.info().testId;
  } catch {
    return '';
  }
}

async function rememberSession(page: Page): Promise<void> {
  const token = await page
    .evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? 'null') as { accessToken?: string } | null)?.accessToken, SESSION_STORAGE_KEY)
    .catch(() => undefined);
  if (token) sessionsToLogOut.push({ testId: currentTestId(), token });
}

async function logoutEarlierTests(): Promise<void> {
  const now = currentTestId();
  for (let i = sessionsToLogOut.length - 1; i >= 0; i--) {
    const { testId, token } = sessionsToLogOut[i]!;
    if (testId === now) continue;
    sessionsToLogOut.splice(i, 1);
    await fetch(`${HS_URL}/_matrix/client/v3/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => undefined); // already logged out by the test itself: fine
  }
}

/**
 * Phase 5 (BUG-19): the security banner (44 px phone, 48 px desktop; correct for an account without encryption set
 * up) mounts ~1 s after the shell, after the first /sync + /keys/query, and shifts the conversation column. Wait for
 * the security status and, when there is a hint, the banner, so geometry and scroll baselines are taken after it.
 * A no-op when the dev hook is absent (a production build).
 */
export async function settleSecurityBanner(page: Page): Promise<void> {
  const hint = await page
    .waitForFunction(
      () => {
        const hook = (window as any).__matrixPoc?.security;
        if (!hook) return { hint: null };
        const s = hook.store.getState();
        return s.status !== null ? { hint: s.hint ?? null } : false;
      },
      undefined,
      { timeout: 30_000 },
    )
    .then((h) => h.jsonValue() as Promise<{ hint: unknown }>)
    .then((v) => v.hint)
    .catch(() => null);
  if (hint) await expect(page.getByTestId('security-banner')).toBeVisible();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** Clicks logout and waits for the login form. */
export async function logout(page: Page): Promise<void> {
  await page.getByTestId('logout-button').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
}

/** Raw localStorage snapshot, for the session-persistence criteria. */
export async function readLocalStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...window.localStorage }) as Record<string, string>);
}
