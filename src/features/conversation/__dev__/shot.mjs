/**
 * Throwaway Dev B verification script (not part of the product).
 *   node src/features/conversation/__dev__/shot.mjs [outPath]
 * Logs in as alice against the private dev server on :5182, exercises the conversation feature and
 * screenshots. Run with the dev server already listening.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.DEV_B_BASE ?? 'http://localhost:5182';
const OUT = process.argv[2] ?? 'docs/screenshots/dev-b-conversation.png';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const E = seed.events;

const log = (...a) => console.log('[dev-b]', ...a);
const errors = [];

async function loginAsAlice(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const form = page.getByTestId('login-form');
  if (await form.isVisible().catch(() => false)) {
    await page.getByTestId('login-username').fill('alice');
    await page.getByTestId('login-password').fill('password123');
    await page.getByTestId('login-submit').click();
  }
  await page.getByTestId('app-shell').waitFor({ timeout: 30000 });
  await page.getByTestId('message-list').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('msc4143')) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await loginAsAlice(page);
log('logged in');

const list = page.getByTestId('message-list');
const row = (id) => page.getByTestId(`message-${id}`);
const count = (loc) => loc.count();

// --- AC-B1 / AC-B3-1 -------------------------------------------------------
log('B1-1 last visible:', await row(E['general.last']).isVisible());
log('B3-1 first NOT in DOM (want 0):', await count(row(E['general.first'])));
log('B1-7 day dividers:', await count(page.getByTestId('day-divider')));

// --- AC-B3-2 pagination ----------------------------------------------------
const anchorId = await page.locator('[data-testid^="message-$"]').first().getAttribute('data-event-id');
await list.evaluate((el) => el.scrollTo({ top: 0 }));
const boxBefore = await page.locator(`[data-event-id="${anchorId}"]`).boundingBox();
await page.waitForTimeout(2500);
const boxAfter = await page.locator(`[data-event-id="${anchorId}"]`).boundingBox();
log('B3-2 anchor y before/after (want equal):', boxBefore?.y?.toFixed(1), boxAfter?.y?.toFixed(1), '| rows now:', await count(page.locator('[data-testid^="message-$"]')));

for (let i = 0; i < 4; i++) {
  await list.evaluate((el) => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(1500);
}
log('B3-2 first now present:', await count(row(E['general.first'])));
log('B3-3 timeline-start visible:', await page.getByTestId('timeline-start').isVisible().catch(() => false));
log('B3-3 timeline-start text:', (await page.getByTestId('timeline-start').textContent().catch(() => 'n/a'))?.trim());

// --- seeded content (the initial 30-event window slides as new messages arrive) -------------
log('B1-4 edited marker:', await count(row(E['general.edited']).getByTestId('message-edited')));
log('B1-4 edited body:', (await row(E['general.edited']).getByTestId('message-body').textContent())?.trim());
log('B1-5 no m.replace row:', await count(page.locator('[data-testid^="message-$"]', { hasText: '* Looks great' })));
log('B4-2 code block:', await count(row(E['general.code']).locator('pre code')));
log('B4-3 link:', await row(E['general.link']).locator('a').first().getAttribute('href'), await row(E['general.link']).locator('a').first().getAttribute('rel'));
log('B4-7 mention pill:', await row(E['general.mention']).getByTestId('message-mention').textContent());
log('B4-5 image src:', await row(E['general.image']).getByTestId('message-image').getAttribute('src'));
log('B4-5 image size:', await row(E['general.image']).getByTestId('message-image').getAttribute('width'), 'x', await row(E['general.image']).getByTestId('message-image').getAttribute('height'));
log('B4-1 bold:', await count(row(E['general.bold']).locator('strong')));
log('B6-1 reply quote author:', await row(E['general.reply']).getByTestId('message-reply-quote-author').textContent());
log('B6-1 reply quote text:', (await row(E['general.reply']).getByTestId('message-reply-quote').textContent())?.trim());

// --- AC-B5-1 seeded reactions (only loaded after pagination) ---------------
const p1 = row(E['general.first']).getByTestId('reaction-🎉');
log('B5-1 #1 🎉 count/mine:', await p1.getAttribute('data-count'), await p1.getAttribute('data-mine'), '| title:', await p1.getAttribute('title'));
const p11 = row(E['general.reacted']).getByTestId('reaction-👍');
log('B5-1 #11 👍 count/mine:', await p11.getAttribute('data-count'), await p11.getAttribute('data-mine'));

// --- AC-B1-2/3 grouping ----------------------------------------------------
const senders = await page.locator('[data-testid^="message-$"]').evaluateAll((els) =>
  els.slice(0, 8).map((el) => `${el.getAttribute('data-sender')}/${el.getAttribute('data-group-start')}`),
);
log('B1-2/3 first 8 rows sender/groupStart:', senders.join('  '));

// --- AC-B5-2/3 picker + toggle --------------------------------------------
const reacted = row(E['general.reacted']);
const mine = reacted.getByTestId('reaction-🎉');
await reacted.scrollIntoViewIfNeeded();
// Leftovers from an earlier run: make sure alice has no 🎉 on #11 before testing "pick adds it".
if (await mine.count()) {
  await mine.click();
  await page.waitForTimeout(1800);
  log('B5-4 pre-clean removed my 🎉 (want 0):', await count(mine));
}
await reacted.hover();
await reacted.getByTestId('message-action-react').click();
await page.getByTestId('reaction-picker').waitFor({ timeout: 4000 });
log('B5-2 picker options:', await count(page.locator('[data-testid^="reaction-picker-"]')));
await page.getByTestId('reaction-picker-🎉').click();
await page.waitForTimeout(1800);
log('B5-3 added 🎉 count/mine:', await mine.getAttribute('data-count'), await mine.getAttribute('data-mine'));
await mine.click();
await page.waitForTimeout(1800);
log('B5-4 removed again (want 0):', await count(mine));

// --- AC-B6-5 jump from quote ----------------------------------------------
await row(E['general.reply']).scrollIntoViewIfNeeded();
await row(E['general.reply']).getByTestId('message-reply-quote').click();
await page.waitForTimeout(1200);
log('B6-5 target in view:', !!(await row(E['general.replyTarget']).boundingBox()));

// --- composer flows in #dev ----------------------------------------------
await page.getByTestId(`channel-item-${seed.rooms.dev}`).click();
await page.waitForTimeout(1500);
const input = page.getByTestId('composer-input');
log('B2-6 placeholder:', await input.getAttribute('placeholder'));
log('B2-4 send disabled when empty:', await page.getByTestId('composer-send').isDisabled());

// B6-2/3 reply
const target = page.locator('[data-testid^="message-$"]').last();
const targetId = await target.getAttribute('data-event-id');
await target.hover();
await target.getByTestId('message-action-reply').click();
await page.getByTestId('composer-reply-banner').waitFor({ timeout: 3000 });
log('B6-2 banner text:', (await page.getByTestId('composer-reply-banner').textContent())?.trim());
await input.fill('Dev B check: reply');
await input.press('Enter');
await page.waitForTimeout(2000);
log('B6-3 banner cleared:', (await count(page.getByTestId('composer-reply-banner'))) === 0);
const sent = page.locator('[data-testid^="message-$"]').last();
log('B6-3 new row has quote:', await count(sent.getByTestId('message-reply-quote')), '| target was', targetId?.slice(0, 8));

// B2-2 shift+enter
await input.fill('');
await input.type('line one');
await input.press('Shift+Enter');
await input.type('line two');
log('B2-2 newline kept:', JSON.stringify(await input.inputValue()));
await input.press('Enter');
await page.waitForTimeout(1500);

// B9-2 edit my own last message
const own = page.locator('[data-sender="@alice:localhost"]').last();
log('B9-2 row to edit:', (await own.getByTestId('message-body').textContent())?.trim(), '| id', (await own.getAttribute('data-event-id'))?.slice(0, 8));
await own.hover();
await own.getByTestId('message-action-edit').click();
await page.getByTestId('composer-edit-banner').waitFor({ timeout: 3000 });
log('B9-2 edit prefill:', JSON.stringify(await input.inputValue()));
await input.fill('Dev B check: edited');
await input.press('Enter');
await page.waitForTimeout(2000);
log('B9-2 edited marker:', await count(page.locator('[data-sender="@alice:localhost"]').last().getByTestId('message-edited')));

// B9-3 ArrowUp opens edit on my last message
await input.press('ArrowUp');
await page.waitForTimeout(400);
log('B9-3 ArrowUp opened edit banner:', await count(page.getByTestId('composer-edit-banner')), '| value:', JSON.stringify(await input.inputValue()));
await input.press('Escape');
await page.waitForTimeout(300);
log('B9-3 escape cleared edit:', (await count(page.getByTestId('composer-edit-banner'))) === 0);


// B8-3 upload a text file
await page.getByTestId('composer-file-input').setInputFiles({ name: 'dev-b-note.txt', mimeType: 'text/plain', buffer: Buffer.from('dev b upload check') });
await page.waitForTimeout(2500);
log('B8-3 file row:', await count(page.locator('[data-testid^="message-$"]').last().getByTestId('message-file')));

// B9-4 delete flow on my own message
const toDelete = page.locator('[data-sender="@alice:localhost"]').last();
const delId = await toDelete.getAttribute('data-event-id');
await toDelete.hover();
await toDelete.getByTestId('message-action-delete').click();
await page.getByTestId('delete-dialog').waitFor({ timeout: 3000 });
await page.getByTestId('delete-confirm').click();
await page.waitForTimeout(2000);
log('B9-4 redacted:', await count(page.locator(`[data-event-id="${delId}"]`).getByTestId('message-redacted')));

// --- screenshots ----------------------------------------------------------
mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT.replace('.png', '-dev.png') });
await page.getByTestId(`channel-item-${seed.rooms.general}`).click();
await page.waitForTimeout(1800);

// B10 mention autocomplete (carol is only a member of #general)
const gInput = page.getByTestId('composer-input');
await gInput.fill('');
await gInput.type('@ca');
await page.waitForTimeout(600);
log('B10-1 autocomplete:', await count(page.getByTestId('mention-autocomplete')), '| carol option:', await count(page.getByTestId('mention-option-@carol:localhost')));
await gInput.press('Enter');
await page.waitForTimeout(300);
log('B10-2 inserted:', JSON.stringify(await gInput.inputValue()));
await gInput.press('Escape');
await gInput.fill('@ca');
await page.waitForTimeout(400);
await gInput.press('Escape');
await page.waitForTimeout(200);
log('B10-3 closed on escape:', (await count(page.getByTestId('mention-autocomplete'))) === 0);
await gInput.fill('');
await page.waitForTimeout(400);
await page.screenshot({ path: OUT });
log('screenshots ->', OUT);
log('console errors:', errors.length ? errors : 'none');

await browser.close();
