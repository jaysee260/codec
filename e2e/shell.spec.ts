/**
 * Starter spec from the Principal covering the shell criteria AC-SH-1..5 (docs/ACCEPTANCE.md).
 * QA owns this folder: keep, extend or replace freely. Requires a seeded homeserver on :8008.
 */
import { expect, test, type Page } from '@playwright/test';

const USER = 'alice';
const PASSWORD = 'password123';

async function login(page: Page, user = USER, password = PASSWORD): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

test.describe('shell', () => {
  test('AC-SH-1 logged out shows the login form, not the shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
  });

  test('AC-SH-2 login as alice shows loading then the shell with her name', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('current-user')).toContainText('Alice Park');
    await expect(page.getByTestId('space-rail').locator('[data-name="Acme HQ"]')).toBeVisible();
  });

  test('AC-SH-3 wrong password shows login-error and stays on the form', async ({ page }) => {
    await login(page, USER, 'nope');
    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
  });

  test('AC-SH-4 session survives a reload', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('login-form')).toHaveCount(0);
  });

  test('AC-SH-5 logout returns to the login form and clears the token', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    expect(stored).not.toContain('accessToken');
  });
});
