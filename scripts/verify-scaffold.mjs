#!/usr/bin/env node
/**
 * Throwaway end-to-end check of the scaffold (not part of the QA suite).
 * Requires: homeserver up + seeded, `npm run dev` running on :5173, Playwright chromium installed.
 *
 *   node scripts/verify-scaffold.mjs            -> logs in as alice, checks the shell, screenshots
 *   node scripts/verify-scaffold.mjs --login-only -> only checks the login screen renders (no homeserver)
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const loginOnly = process.argv.includes('--login-only');
const shotDir = path.join(ROOT, 'docs', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
});

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-form').waitFor({ timeout: 15_000 });
  console.log('login form rendered');

  if (loginOnly) {
    await page.getByTestId('login-username').fill('alice');
    await page.getByTestId('login-password').fill('password123');
    await page.getByTestId('login-submit').click();
    // Without a homeserver we expect a visible error and to stay on the form.
    await page.getByTestId('login-error').waitFor({ timeout: 20_000 });
    console.log('login error shown:', await page.getByTestId('login-error').textContent());
    await page.screenshot({ path: path.join(shotDir, 'scaffold-login.png') });
    console.log('saved docs/screenshots/scaffold-login.png');
  } else {
    await page.getByTestId('login-username').fill('alice');
    await page.getByTestId('login-password').fill('password123');
    await page.getByTestId('login-submit').click();
    await page.getByTestId('app-shell').waitFor({ timeout: 30_000 });
    console.log('shell rendered');

    const rail = page.getByTestId('space-rail');
    await rail.locator('[data-name="Acme HQ"]').waitFor({ timeout: 10_000 });
    await rail.locator('[data-name="Gaming"]').waitFor({ timeout: 10_000 });
    console.log('spaces: Acme HQ, Gaming');

    const general = page.getByTestId('channel-list').locator('[data-name="general"]');
    await general.waitFor({ timeout: 10_000 });
    if ((await general.getAttribute('data-selected')) !== 'true') await general.click();
    await page.getByTestId('channel-header-name').filter({ hasText: 'general' }).waitFor({ timeout: 10_000 });
    await page.getByTestId('message-list').getByText('Done. Have a good weekend all!').waitFor({ timeout: 15_000 });
    const rows = await page.getByTestId('message-list').locator('[data-testid^="message-$"]').count();
    console.log(`#general shows ${rows} message rows`);
    const currentUser = await page.getByTestId('current-user').textContent();
    console.log('current user:', currentUser?.trim());

    await page.screenshot({ path: path.join(shotDir, 'scaffold.png') });
    console.log('saved docs/screenshots/scaffold.png');
  }
} finally {
  if (errors.length) {
    console.log('browser errors:');
    for (const e of errors) console.log('  ' + e);
  }
  await browser.close();
}
