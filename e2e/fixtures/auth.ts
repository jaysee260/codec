/**
 * Login helpers (QA-1). Every test logs in fresh: Playwright gives each test its own browser
 * context, so localStorage starts empty and navigation lands on the store's default selection
 * (first space alphabetically = Acme HQ, first channel = #general — docs/ARCHITECTURE.md Deltas).
 */
import { expect, type Page } from '@playwright/test';
import { DISPLAY_NAMES, PASSWORD, type UserKey } from './seed.ts';

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
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-password').fill(opts.password ?? PASSWORD);
  await page.getByTestId('login-submit').click();

  if (opts.expectFailure) return;

  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: SHELL_TIMEOUT });
  await expect(page.getByTestId('current-user')).toContainText(DISPLAY_NAMES[user], {
    timeout: SHELL_TIMEOUT,
  });
  // The rail is the last thing to paint once the room store has done its first recompute.
  await expect(page.getByTestId('space-rail')).toBeVisible();
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
