/**
 * Throwaway Dev B live-update check: drives bob/dave through the client-server API while alice's
 * UI is open, covering typing indicator, read receipts, live reactions, sanitising, redaction,
 * auto-scroll rules and uploads.
 *   node src/features/conversation/__dev__/live.mjs
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const HS = 'http://localhost:8008';
const BASE = 'http://localhost:5182';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const log = (...a) => console.log('[live]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(user) {
  const res = await fetch(`${HS}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: 'password123' }),
  }).then((r) => r.json());
  const token = res.access_token;
  const userId = res.user_id;
  const call = async (method, path, body) => {
    const r = await fetch(`${HS}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };
  let txn = Date.now();
  return {
    userId,
    send: (roomId, body) => call('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn++}`, { msgtype: 'm.text', body }),
    sendHtml: (roomId, body, html) =>
      call('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn++}`, {
        msgtype: 'm.text',
        body,
        format: 'org.matrix.custom.html',
        formatted_body: html,
      }),
    react: (roomId, eventId, key) =>
      call('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txn++}`, {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
      }),
    redact: (roomId, eventId) => call('PUT', `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txn++}`, {}),
    typing: (roomId, typing, timeout = 20000) =>
      call('PUT', `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`, typing ? { typing, timeout } : { typing }),
    messages: (roomId, limit = 20) => call('GET', `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`),
    async receiptOf(roomId, ofUser) {
      const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }));
      const sync = await call('GET', `/sync?filter=${filter}&timeout=0`);
      const room = sync.rooms?.join?.[roomId];
      for (const ev of room?.ephemeral?.events ?? []) {
        if (ev.type !== 'm.receipt') continue;
        for (const [eventId, receipts] of Object.entries(ev.content ?? {})) {
          if (receipts?.['m.read']?.[ofUser]) return eventId;
        }
      }
      return null;
    },
  };
}

const bob = await api('bob');
const dave = await api('dave');
const ALICE = '@alice:localhost';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
if (await page.getByTestId('login-form').isVisible().catch(() => false)) {
  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
}
await page.getByTestId('app-shell').waitFor({ timeout: 30000 });
await page.getByTestId('message-list').waitFor({ timeout: 30000 });
await sleep(1200);
log('logged in as alice');

const indicator = page.getByTestId('typing-indicator');
const list = page.getByTestId('message-list');
const rowOf = (id) => page.getByTestId(`message-${id}`);

// --- AC-B7-1 typing in the DM ---------------------------------------------
await page.getByTestId('space-item-home').click();
await page.getByTestId(`dm-item-${seed.rooms['dm-alice-bob']}`).click();
await sleep(1000);
await bob.typing(seed.rooms['dm-alice-bob'], true);
await indicator.waitFor({ timeout: 5000 });
log('B7-1 indicator:', JSON.stringify(await indicator.textContent()));
await bob.typing(seed.rooms['dm-alice-bob'], false);
await page.waitForFunction(() => !document.querySelector('[data-testid="typing-indicator"]'), null, { timeout: 8000 });
log('B7-1 cleared after typing=false: true');

// --- AC-B7-2 two typists in #dev ------------------------------------------
await page.getByTestId(`space-item-${seed.rooms['acme-hq']}`).click();
await page.getByTestId(`channel-item-${seed.rooms.dev}`).click();
await sleep(1200);
await bob.typing(seed.rooms.dev, true);
await dave.typing(seed.rooms.dev, true);
await indicator.waitFor({ timeout: 5000 });
await sleep(700);
log('B7-2 two typists:', JSON.stringify(await indicator.textContent()));
await bob.typing(seed.rooms.dev, false);
await dave.typing(seed.rooms.dev, false);
await sleep(800);

// --- AC-B7-4 receipt for an incoming message + auto-scroll ---------------
await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
await sleep(400);
const incoming = await bob.send(seed.rooms.dev, `[dev-b live] incoming ${Date.now()}`);
await rowOf(incoming.event_id).waitFor({ timeout: 10000 });
await sleep(1500);
const atBottom = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40);
log('B3-4 auto-scrolled while at bottom:', atBottom);
let receipt = null;
for (let i = 0; i < 12 && receipt !== incoming.event_id; i++) {
  receipt = await bob.receiptOf(seed.rooms.dev, ALICE);
  if (receipt !== incoming.event_id) await sleep(700);
}
log('B7-4 alice receipt == incoming:', receipt === incoming.event_id, receipt?.slice(0, 10));

// --- AC-B3-4 no auto-scroll while scrolled up ----------------------------
await list.evaluate((el) => (el.scrollTop = 0));
await sleep(2500);
const topBefore = await list.evaluate((el) => el.scrollTop);
const away = await bob.send(seed.rooms.dev, `[dev-b live] while scrolled up ${Date.now()}`);
await rowOf(away.event_id).waitFor({ timeout: 10000 });
await sleep(1200);
const stillUp = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight >= 40);
log('B3-4 stayed put while scrolled up:', stillUp, '| scrollTop', topBefore, '->', await list.evaluate((el) => el.scrollTop));
log('B3-4 jump-to-present button shown:', await page.getByTestId('scroll-to-bottom').count());

// --- AC-B5-5 live reaction from bob --------------------------------------
await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
await sleep(500);
await bob.react(seed.rooms.dev, incoming.event_id, '😂');
const laugh = rowOf(incoming.event_id).getByTestId('reaction-😂');
await laugh.waitFor({ timeout: 10000 });
log('B5-5 live reaction count:', await laugh.getAttribute('data-count'), 'mine:', await laugh.getAttribute('data-mine'));

// --- AC-B4-4 sanitising --------------------------------------------------
const marker = `xss-${Date.now()}`;
const xss = await bob.sendHtml(seed.rooms.dev, `hi ${marker}`, `<img src=x onerror=alert(1)><script>alert(2)</script>hi ${marker}`);
const xssRow = rowOf(xss.event_id);
await xssRow.waitFor({ timeout: 10000 });
const inner = await xssRow.getByTestId('message-body').innerHTML();
log('B4-4 contains marker:', (await xssRow.getByTestId('message-body').innerText()).includes(marker));
log('B4-4 no script/onerror:', !inner.toLowerCase().includes('<script') && !inner.toLowerCase().includes('onerror'));

// --- AC-B1-6 redaction --------------------------------------------------
const victim = await bob.send(seed.rooms.dev, `[dev-b live] redact me ${Date.now()}`);
await rowOf(victim.event_id).waitFor({ timeout: 10000 });
await bob.redact(seed.rooms.dev, victim.event_id);
await rowOf(victim.event_id).getByTestId('message-redacted').waitFor({ timeout: 10000 });
log('B1-6 redacted text:', JSON.stringify(await rowOf(victim.event_id).getByTestId('message-redacted').textContent()));
log('B1-6 message-body gone:', (await rowOf(victim.event_id).getByTestId('message-body').count()) === 0);

// --- AC-B8-1/2 upload a PNG ---------------------------------------------
const progressSeen = page
  .getByTestId('upload-progress')
  .waitFor({ state: 'visible', timeout: 8000 })
  .then(() => true)
  .catch(() => false);
await page.getByTestId('composer-file-input').setInputFiles('e2e/fixtures/test-image.png');
log('B8-2 upload-progress seen:', await progressSeen);
const img = list.getByTestId('message-image').last();
await img.waitFor({ timeout: 20000 });
await sleep(1200);
const recent = await bob.messages(seed.rooms.dev, 10);
const imageEvent = recent.chunk.find((e) => e.content?.msgtype === 'm.image');
log('B8-2 info:', JSON.stringify(imageEvent?.content?.info), 'sender', imageEvent?.sender);
log('B8-2 rendered width:', (await img.boundingBox())?.width);

// --- AC-B7-3 receipt on opening #random ---------------------------------
await page.getByTestId(`channel-item-${seed.rooms.random}`).click();
await sleep(1200);
const randomMsgs = await bob.messages(seed.rooms.random, 10);
const lastRandom = randomMsgs.chunk.find((e) => e.type === 'm.room.message');
let rReceipt = null;
for (let i = 0; i < 12 && rReceipt !== lastRandom.event_id; i++) {
  rReceipt = await bob.receiptOf(seed.rooms.random, ALICE);
  if (rReceipt !== lastRandom.event_id) await sleep(700);
}
log('B7-3 receipt for last #random event:', rReceipt === lastRandom.event_id, rReceipt?.slice(0, 10), 'want', lastRandom.event_id.slice(0, 10));

log('page errors:', errors.length ? errors : 'none');
await browser.close();
