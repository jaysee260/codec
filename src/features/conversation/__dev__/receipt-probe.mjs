/** Throwaway: check the read receipt alice's UI sends when opening #random. */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const HS = 'http://localhost:8008';
const BASE = 'http://localhost:5182';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const log = (...a) => console.log('[receipt]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALICE = '@alice:localhost';
const ROOM = seed.rooms.random;

const login = await fetch(`${HS}/_matrix/client/v3/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: 'bob' }, password: 'password123' }),
}).then((r) => r.json());
const H = { authorization: `Bearer ${login.access_token}`, 'content-type': 'application/json' };

const newestMessage = async () => {
  const r = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/messages?dir=b&limit=15`, { headers: H }).then((x) => x.json());
  return r.chunk.find((e) => e.type === 'm.room.message');
};
const receiptOf = async () => {
  const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 20 } } }));
  const sync = await fetch(`${HS}/_matrix/client/v3/sync?filter=${filter}&timeout=0`, { headers: H }).then((x) => x.json());
  const room = sync.rooms?.join?.[ROOM];
  for (const ev of room?.ephemeral?.events ?? []) {
    if (ev.type !== 'm.receipt') continue;
    for (const [eventId, receipts] of Object.entries(ev.content ?? {})) {
      if (receipts?.['m.read']?.[ALICE]) return eventId;
    }
  }
  return null;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.text().includes('DEVB-RCPT')) log('page:', m.text()); });
page.on('response', (r) => { if (r.url().includes('/receipt/')) log('net:', r.status(), decodeURIComponent(r.url().split('/receipt/')[1] ?? '')); });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
if (await page.getByTestId('login-form').isVisible().catch(() => false)) {
  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
}
await page.getByTestId('app-shell').waitFor({ timeout: 30000 });
await page.getByTestId('message-list').waitFor({ timeout: 30000 });
await sleep(1200);

const before = await newestMessage();
log('server newest message:', before.event_id.slice(0, 10), JSON.stringify((before.content.body ?? '').slice(0, 40)));
log('receipt before opening:', (await receiptOf())?.slice(0, 10));

await page.getByTestId(`channel-item-${ROOM}`).click();
await sleep(2500);
const domLast = await page.getByTestId('message-list').locator('[data-testid^="message-$"]').last().getAttribute('data-event-id');
log('last row in the DOM:', domLast?.slice(0, 10));
log('receipt after opening:', (await receiptOf())?.slice(0, 10), '| want', before.event_id.slice(0, 10));
log(
  'at bottom:',
  await page.getByTestId('message-list').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
);

// now a fresh incoming message while the room stays open
const sent = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/send/m.room.message/${Date.now()}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ msgtype: 'm.text', body: `[dev-b receipt probe] ${Date.now()}` }),
}).then((r) => r.json());
await page.getByTestId(`message-${sent.event_id}`).waitFor({ timeout: 10000 });
let got = null;
for (let i = 0; i < 12 && got !== sent.event_id; i++) {
  got = await receiptOf();
  if (got !== sent.event_id) await sleep(600);
}
log('receipt for the new message:', got === sent.event_id, got?.slice(0, 10), 'want', sent.event_id.slice(0, 10));

await browser.close();
