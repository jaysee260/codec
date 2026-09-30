/** Throwaway: reproduce the "edit button prefills nothing" case in #dev. */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:5182';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const log = (...a) => console.log('[probe]', ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => {
  if (m.text().includes('DEVB-DEBUG')) log('page:', m.text());
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
if (await page.getByTestId('login-form').isVisible().catch(() => false)) {
  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
}
await page.getByTestId('app-shell').waitFor({ timeout: 30000 });
await page.getByTestId(`channel-item-${seed.rooms.dev}`).click();
await page.waitForTimeout(1500);

const input = page.getByTestId('composer-input');

// case A: edit a message that was NOT sent in this session
const older = page.locator('[data-sender="@alice:localhost"]').first();
log('A row:', (await older.getByTestId('message-body').textContent())?.trim().slice(0, 40), (await older.getAttribute('data-event-id'))?.slice(0, 8));
await older.hover();
await older.getByTestId('message-action-edit').click();
await page.getByTestId('composer-edit-banner').waitFor({ timeout: 4000 });
log('A prefill:', JSON.stringify(await input.inputValue()));
await input.press('Escape');
await page.waitForTimeout(300);

// case B: send a message, then edit it
await input.fill(`probe ${Date.now()}`);
await input.press('Enter');
await page.waitForTimeout(2500);
const fresh = page.locator('[data-sender="@alice:localhost"]').last();
log('B row:', (await fresh.getByTestId('message-body').textContent())?.trim().slice(0, 40), (await fresh.getAttribute('data-event-id'))?.slice(0, 8));
await fresh.hover();
await fresh.getByTestId('message-action-edit').click();
await page.getByTestId('composer-edit-banner').waitFor({ timeout: 4000 });
log('B prefill:', JSON.stringify(await input.inputValue()));
await page.waitForTimeout(500);
log('B prefill after settle:', JSON.stringify(await input.inputValue()));
await input.press('Escape');

await browser.close();
