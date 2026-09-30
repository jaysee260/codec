/** Dev A: high-DPI crops of the navigation surfaces for a visual check. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const R = seed.rooms;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:5181');
await page.getByTestId('login-username').fill('alice');
await page.getByTestId('login-password').fill('password123');
await page.getByTestId('login-submit').click();
await page.getByTestId('app-shell').waitFor({ timeout: 40000 });
await page.waitForTimeout(5000);

await page.getByTestId('space-rail').screenshot({ path: 'docs/screenshots/dev-a-zoom-rail.png' });
await page.getByTestId('channel-sidebar').screenshot({ path: 'docs/screenshots/dev-a-zoom-sidebar.png' });
await page.getByTestId('member-list').screenshot({ path: 'docs/screenshots/dev-a-zoom-members.png' });
await page.getByTestId('channel-header').screenshot({ path: 'docs/screenshots/dev-a-zoom-header.png' });

// hover the Gaming rail item so the hover pill shows
await page.getByTestId(`space-item-${R.gaming}`).hover();
await page.waitForTimeout(400);
await page.getByTestId('space-rail').screenshot({ path: 'docs/screenshots/dev-a-zoom-rail-hover.png' });

// space menu open
await page.getByTestId('space-menu').click();
await page.waitForTimeout(300);
await page.getByTestId('channel-sidebar').screenshot({ path: 'docs/screenshots/dev-a-zoom-menu.png' });
await page.keyboard.press('Escape');

// home / dm list
await page.getByTestId('space-item-home').click();
await page.waitForTimeout(1500);
await page.getByTestId('channel-sidebar').screenshot({ path: 'docs/screenshots/dev-a-zoom-dms.png' });

// a dialog
await page.getByTestId('dm-new').click();
await page.waitForTimeout(400);
await page.getByTestId('new-dm-dialog').screenshot({ path: 'docs/screenshots/dev-a-zoom-dialog.png' });
await page.keyboard.press('Escape');

await browser.close();
console.log('crops written');
