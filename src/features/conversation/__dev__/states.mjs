/** Throwaway: screenshot of the interactive states (hover toolbar, picker, reply banner, typing). */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const HS = 'http://localhost:8008';
const BASE = 'http://localhost:5182';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DM = seed.rooms['dm-alice-bob'];

const login = await fetch(`${HS}/_matrix/client/v3/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: 'bob' }, password: 'password123' }),
}).then((r) => r.json());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
if (await page.getByTestId('login-form').isVisible().catch(() => false)) {
  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
}
await page.getByTestId('app-shell').waitFor({ timeout: 30000 });
await page.getByTestId('space-item-home').click();
await page.getByTestId(`dm-item-${DM}`).click();
await sleep(1500);

// reply banner on the newest message
const rows = page.getByTestId('message-list').locator('[data-testid^="message-$"]');
const last = rows.last();
await last.hover();
await last.getByTestId('message-action-reply').click();
await sleep(300);

// bob starts typing so the indicator is visible
await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(DM)}/typing/%40bob%3Alocalhost`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${login.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ typing: true, timeout: 30000 }),
});
await sleep(800);

// hover an earlier row and open the reaction picker
const target = rows.nth(Math.max(0, (await rows.count()) - 3));
await target.hover();
await target.getByTestId('message-action-react').click();
await page.getByTestId('reaction-picker').waitFor({ timeout: 4000 });
await target.hover();
await sleep(400);

await page.screenshot({ path: 'docs/screenshots/dev-b-conversation-states.png' });
console.log('[states] written');

await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(DM)}/typing/%40bob%3Alocalhost`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${login.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ typing: false }),
});
await browser.close();
