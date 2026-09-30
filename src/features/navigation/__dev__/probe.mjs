import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const R = seed.rooms;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5181');
await page.getByTestId('login-username').fill('alice');
await page.getByTestId('login-password').fill('password123');
await page.getByTestId('login-submit').click();
await page.getByTestId('app-shell').waitFor({ timeout: 40000 });
await page.waitForTimeout(6000);

const railBadges = await page.getByTestId('space-rail').locator('[data-count]').evaluateAll((els) =>
  els.map((e) => `${e.dataset.testid}=${e.dataset.count}`),
);
const chanBadges = await page.getByTestId('channel-list').locator('[data-count]').evaluateAll((els) =>
  els.map((e) => `${e.dataset.testid}=${e.dataset.count}`),
);
console.log('rail badges:', railBadges);
console.log('channel badges:', chanBadges);
console.log('expect gaming id', R.gaming, 'lobby', R.lobby);

// dump the store's unread map
const unread = await page.evaluate(() => {
  // eslint-disable-next-line no-undef
  return window.__navDebug ?? null;
});
console.log('window debug:', unread);
await browser.close();
