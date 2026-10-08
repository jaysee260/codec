#!/usr/bin/env node
/**
 * Principal's Phase 3 verification script (not part of the QA suite). Drives the dev server with Playwright,
 * logs in as alice, opens #dev and checks the thread core against the live thread posted by
 * `npm run thread:sample` (seed/thread-sample.json):
 *
 *   - thread replies are absent from the main timeline (`room.getLiveTimeline()` and the message list) and
 *     present in `room.getThread(rootId)` / Dev B's ThreadView after `openThread(rootId)` (reply rows inside the
 *     panel keep `message-<id>` ids, so every selector is scoped to `thread-message-list` vs `message-list`);
 *   - a reply posted by bob through the raw API while the page is open lands in the thread only;
 *   - sending from the thread composer: local echo in the thread (not the main list), wire shape of the sent
 *     event (`is_falling_back`, `m.in_reply_to` = previous reply), reaction + edit on a thread reply;
 *   - per-thread unread counts arrive from /sync and clear after a threaded receipt;
 *   - desktop: 400 px thread column replaces the member panel and the member panel comes back on close;
 *   - phone (Pixel 7): the thread covers the conversation below the header, drawers still open on top,
 *     Android-back order (thread first).
 *
 *   npm run dev -- --port 5183          # in another terminal (dev build: __matrixPoc is installed)
 *   npm run thread:sample               # once, to have a thread in #dev
 *   npm run verify:threads              # screenshots -> docs/screenshots/phase3-thread-shell*.png
 *
 * Environment: E2E_BASE_URL (http://localhost:5183), HS_URL (http://localhost:8008), PASSWORD (password123).
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5183';
const HS = (process.env.HS_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
const PASSWORD = process.env.PASSWORD ?? 'password123';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

// Room from the sample (so QA's #dev thread stays as posted); the script posts its own fresh thread below so
// every run starts from the same state (3 replies, unread for alice, nothing of hers in it).
const sample = JSON.parse(readFileSync(path.join(ROOT, 'seed', 'thread-sample.json'), 'utf8'));
const { roomId } = sample;
let rootId;
let replyIds;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10_000, interval = 200 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return v;
    await sleep(interval);
  }
}

// --------------------------------------------------------------------------- raw API (bob)
async function api(method, endpoint, { token, body } = {}) {
  const res = await fetch(HS + endpoint, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function loginApi(user) {
  const r = await api('POST', '/_matrix/client/v3/login', { body: { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: PASSWORD, initial_device_display_name: 'verify-thread-shell' } });
  return { userId: r.user_id, token: r.access_token };
}

// --------------------------------------------------------------------------- browser helpers
async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-form').waitFor({ timeout: 15_000 });
  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('app-shell').waitFor({ timeout: 30_000 });
  await page.evaluate((id) => window.__matrixPoc.rooms.getState().selectRoom(id), roomId);
  await page.getByTestId('message-list').locator('[data-testid^="message-$"]').first().waitFor({ timeout: 20_000 });
  await sleep(500);
}

/**
 * Console/page errors, minus the expected ones. "Failed to load resource: ... 404" console lines carry no URL,
 * so 404 responses are recorded separately: the SDK's MatrixRTC probe (msc4143) 404s once per startClient and
 * is whitelisted (docs/ARCHITECTURE.md); any other 404 is reported with its URL.
 */
function collectErrors(page) {
  const errors = [];
  const notFound = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/msc4143|rtc\/transports/.test(m.text())) return;
    if (/Failed to load resource: the server responded with a status of 404/.test(m.text())) return; // see notFound
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() === 404 && !/msc4143/.test(r.url())) notFound.push(`404: ${r.url()}`);
  });
  return { errors, notFound, all: () => [...errors, ...notFound] };
}

const threadReply = (body, root, latest) => ({ msgtype: 'm.text', body, 'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: latest } } });
async function sendAs(session, content) {
  const r = await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/verify-${Date.now()}-${Math.random().toString(36).slice(2)}`, { token: session.token, body: content });
  return r.event_id;
}

const browser = await chromium.launch();
try {
  const bob = await loginApi('bob');
  const carol = await loginApi('carol');
  const aliceApi = await loginApi('alice');
  // Fresh thread: alice root, replies bob / carol / bob (exact client wire shape).
  rootId = await sendAs(aliceApi, { msgtype: 'm.text', body: `Thread sample (verify ${new Date().toISOString()}): reply in the thread, not here.` });
  replyIds = [];
  for (const [who, body] of [[bob, 'First reply in the thread.'], [carol, 'Second one, still in the thread.'], [bob, 'Third reply.']]) {
    replyIds.push(await sendAs(who, threadReply(body, rootId, replyIds[replyIds.length - 1] ?? rootId)));
  }
  console.log(`fresh thread ${rootId} with ${replyIds.length} replies in ${roomId}`);

  // ======================================================================== desktop
  const desktop = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } });
  const page = await desktop.newPage();
  const errors = collectErrors(page);
  await login(page);

  const sdk = await page.evaluate(
    ({ roomId, rootId, replyIds }) => {
      const p = window.__matrixPoc;
      const client = p.getClient();
      const room = client.getRoom(roomId);
      const main = room.getLiveTimeline().getEvents().map((e) => e.getId());
      const thread = room.getThread(rootId);
      return {
        supportsThreads: client.supportsThreads(),
        mainHasRoot: main.includes(rootId),
        mainHasReplies: replyIds.filter((id) => main.includes(id)),
        storeMainHasReplies: (p.timeline.getState().eventsByRoom[roomId] ?? []).map((e) => e.getId()).filter((id) => replyIds.includes(id)),
        threadKnown: !!thread,
        threadLength: thread?.length ?? -1,
        threadReady: !!thread?.initialEventsFetched,
        threadEvents: (thread?.events ?? []).map((e) => e.getId()),
        summary: (() => {
          const s = p.getThreadSummary(roomId, rootId);
          return s && { count: s.count, participants: s.participants, participated: s.participated, hasUnread: s.hasUnread, latestId: s.latestEvent?.getId() };
        })(),
        threadUnread: room.getThreadUnreadNotificationCount(rootId),
        roomHasThreadUnread: room.hasThreadUnreadNotification(),
        roomUnreadMain: room.getRoomUnreadNotificationCount(),
        roomUnreadSdkTotal: room.getUnreadNotificationCount(),
        storeThreadUnread: !!p.rooms.getState().threadUnreadByRoom[roomId],
      };
    },
    { roomId, rootId, replyIds },
  );
  check('client.supportsThreads()', sdk.supportsThreads);
  check('root is in the main live timeline', sdk.mainHasRoot);
  check('replies are NOT in room.getLiveTimeline()', sdk.mainHasReplies.length === 0, `${sdk.mainHasReplies.length} leaked`);
  check('replies are NOT in the store main snapshot', sdk.storeMainHasReplies.length === 0);
  const domReplies = await page.getByTestId('message-list').locator(replyIds.map((id) => `[data-testid="message-${id}"]`).join(', ')).count();
  check('replies are NOT rendered in message-list', domReplies === 0, `${domReplies} rows`);
  check('root row rendered in message-list', (await page.getByTestId('message-list').locator(`[data-testid="message-${rootId}"]`).count()) === 1);
  check('SDK Thread exists for the root (from sync)', sdk.threadKnown, `length ${sdk.threadLength}, ready ${sdk.threadReady}`);
  // Spec: the root author counts as having participated (alice sent the root).
  check('useThreadSummary data: count 3, participants bob+carol (newest first), alice participated as root author', !!sdk.summary && sdk.summary.count === 3 && sdk.summary.participants[0] === '@bob:localhost' && sdk.summary.participants.includes('@carol:localhost') && sdk.summary.participated === true, JSON.stringify(sdk.summary));
  check('SDK does not offer pending events to thread timeline sets (bridge adds the local echo)', await page.evaluate(({ roomId, rootId }) => { const room = window.__matrixPoc.getClient().getRoom(roomId); return !room.getTimelineSets().includes(room.getThread(rootId).timelineSet); }, { roomId, rootId }));
  check('per-thread unread count arrives from /sync (alice has not read the thread)', sdk.threadUnread > 0 && sdk.roomHasThreadUnread && sdk.storeThreadUnread, `thread ${sdk.threadUnread}, room.hasThreadUnreadNotification ${sdk.roomHasThreadUnread}, store ${sdk.storeThreadUnread}`);
  check('unreadByRoom is main-only (SDK total would include threads)', sdk.roomUnreadMain <= sdk.roomUnreadSdkTotal, `main ${sdk.roomUnreadMain} vs sdk total ${sdk.roomUnreadSdkTotal}`);

  // Open the thread through the store (Dev B's summary row / action is not in yet).
  const membersBefore = await page.getByTestId('member-list').isVisible().catch(() => false);
  await page.evaluate((id) => window.__matrixPoc.openThread(id), rootId);
  const panel = page.getByTestId('thread-panel');
  await panel.waitFor({ timeout: 10_000 });
  check('thread-panel renders after openThread', true);
  check('app-shell[data-thread-open=true]', (await page.getByTestId('app-shell').getAttribute('data-thread-open')) === 'true');
  const container = await page.getByTestId('thread-panel-container').boundingBox();
  check('desktop thread column is 400 px wide', !!container && Math.round(container.width) === 400, `${Math.round(container?.width ?? 0)}px`);
  check('member panel collapsed while the thread is open', membersBefore && !(await page.getByTestId('member-list').isVisible().catch(() => false)));
  const rootRow = page.getByTestId('thread-root');
  check('thread-root shows the root', (await rootRow.count()) === 1 && (await rootRow.textContent()).includes('Thread sample'));
  const rows = await waitFor(async () => {
    const n = await page.getByTestId('thread-message-list').locator('[data-testid^="message-$"]').count();
    return n >= 3 ? n : 0;
  });
  check('thread-message-list shows the 3 replies', rows === 3, `${rows} rows`);
  const order = await page.getByTestId('thread-message-list').locator('[data-testid^="message-$"]').evaluateAll((els) => els.map((e) => e.dataset.testid.slice('message-'.length)));
  check('replies in chronological order (oldest first)', JSON.stringify(order) === JSON.stringify(replyIds), order.join(','));
  check('root not listed as a reply', !order.includes(rootId));
  const storeThread = await page.evaluate(({ roomId, rootId }) => {
    const st = window.__matrixPoc.timeline.getState();
    const key = `${roomId}|${rootId}`;
    return { has: key in st.eventsByThread, hasMore: st.canPaginateBackThread[key], n: st.eventsByThread[key]?.length };
  }, { roomId, rootId });
  check('store eventsByThread snapshot present, start of thread reached', storeThread.has && storeThread.hasMore === false, JSON.stringify(storeThread));
  await page.screenshot({ path: path.join(SHOTS, 'phase3-thread-shell.png') });
  console.log('saved docs/screenshots/phase3-thread-shell.png');

  // A reply posted by bob through the raw API while the page is open: thread only, summary updates.
  const bobReply = await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/verify-${Date.now()}`, {
    token: bob.token,
    body: { msgtype: 'm.text', body: 'Live reply from bob via the API.', 'm.relates_to': { rel_type: 'm.thread', event_id: rootId, is_falling_back: true, 'm.in_reply_to': { event_id: replyIds[replyIds.length - 1] } } },
  });
  const live = await waitFor(async () => (await page.getByTestId('thread-message-list').locator(`[data-testid="message-${bobReply.event_id}"]`).count()) === 1);
  check('live API reply from bob appears in the thread panel', live);
  check('live API reply is NOT in the main list', (await page.getByTestId('message-list').locator(`[data-testid="message-${bobReply.event_id}"]`).count()) === 0);
  const liveSdk = await page.evaluate(({ roomId, rootId, id }) => {
    const p = window.__matrixPoc;
    const room = p.getClient().getRoom(roomId);
    const s = p.getThreadSummary(roomId, rootId);
    return { inMain: room.getLiveTimeline().getEvents().some((e) => e.getId() === id), count: s?.count, latest: s?.latestEvent?.getId(), threadUnread: room.getThreadUnreadNotificationCount(rootId) };
  }, { roomId, rootId, id: bobReply.event_id });
  check('live reply not in room.getLiveTimeline(); summary count 4, latest = bob reply', !liveSdk.inMain && liveSdk.count === 4 && liveSdk.latest === bobReply.event_id, JSON.stringify(liveSdk));

  // Send from the thread composer: local echo + wire shape.
  const mainRowsBefore = await page.getByTestId('message-list').locator('[data-testid^="message-$"]').count();
  // Local echo: send through the real action and look at the SDK thread one macrotask later - the pending event
  // (`~` id, status 'sending') is added synchronously by the bridge, while the server ack needs a network round
  // trip. (Polling the DOM for the `~` row is racy on a local Synapse: the ack can land before the first paint.)
  const echo = await page.evaluate(async ({ roomId, rootId }) => {
    const p = window.__matrixPoc;
    const sending = p.actions.sendText(roomId, 'Reply from alice via the thread composer', { threadRoot: rootId });
    await new Promise((r) => setTimeout(r, 0));
    const thread = p.getThreadModel(roomId, rootId);
    const pending = thread.events.filter((e) => e.getSender() === '@alice:localhost' && (e.status === 'sending' || e.getId().startsWith('~')));
    const inMain = p.getClient().getRoom(roomId).getLiveTimeline().getEvents().some((e) => e.getId().startsWith('~'));
    await sending.catch(() => undefined);
    return { pendingInThread: pending.length, pendingInMain: inMain };
  }, { roomId, rootId });
  check('local echo (~ id, status sending) is in the thread timeline before the ack, not in the main timeline', echo.pendingInThread === 1 && !echo.pendingInMain, JSON.stringify(echo));
  const sentId = await waitFor(async () =>
    page.evaluate(({ roomId, rootId }) => {
      const t = window.__matrixPoc.getThreadModel(roomId, rootId);
      const mine = t?.events.filter((e) => e.getSender() === '@alice:localhost' && e.getId().startsWith('$') && e.isRelation('m.thread'));
      return mine?.length ? mine[mine.length - 1].getId() : null;
    }, { roomId, rootId }),
  );
  check('composer reply acknowledged ($ id in the thread)', !!sentId, sentId ?? '');
  await sleep(300);
  check('no duplicate: exactly one row for the sent reply, no ~ rows left', (await page.getByTestId('thread-message-list').locator(`[data-testid="message-${sentId}"]`).count()) === 1 && (await page.getByTestId('thread-message-list').locator('[data-testid^="message-~"]').count()) === 0);
  check('main list did not grow', (await page.getByTestId('message-list').locator('[data-testid^="message-$"]').count()) === mainRowsBefore);
  const wire = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(sentId)}`, { token: bob.token });
  const rel = wire.content['m.relates_to'];
  check('wire shape: rel_type m.thread, event_id root, is_falling_back true, m.in_reply_to = previous reply', rel?.rel_type === 'm.thread' && rel.event_id === rootId && rel.is_falling_back === true && rel['m.in_reply_to']?.event_id === bobReply.event_id, JSON.stringify(rel));
  check('getReplyTargetId ignores the thread fallback', await page.evaluate(({ roomId, id }) => { const ev = window.__matrixPoc.getClient().getRoom(roomId).findEventById(id); return window.__matrixPoc.utils.getReplyTargetId(ev) === undefined && window.__matrixPoc.getDisplayBody(ev).threadRoot !== undefined; }, { roomId, id: sentId }));

  // Reaction + edit on a thread reply.
  await page.evaluate(({ roomId, id }) => window.__matrixPoc.actions.sendReaction(roomId, id, '👍'), { roomId, id: sentId });
  const reacted = await waitFor(async () => page.evaluate(({ roomId, id }) => { const r = window.__matrixPoc.actions.getReactions(roomId, id); return r.length === 1 && r[0].key === '👍' && r[0].mine; }, { roomId, id: sentId }));
  check('reaction on a thread reply aggregates via getReactions', reacted);
  check('reaction did not leak into the main timeline', await page.evaluate(({ roomId }) => !window.__matrixPoc.getClient().getRoom(roomId).getLiveTimeline().getEvents().some((e) => e.getType() === 'm.reaction' && e.getSender() === '@alice:localhost' && e.getTs() > Date.now() - 20_000), { roomId }));
  await page.evaluate(({ roomId, id }) => window.__matrixPoc.actions.editText(roomId, id, 'Reply from alice (edited)'), { roomId, id: sentId });
  const edited = await waitFor(async () => page.evaluate(({ roomId, id }) => { const ev = window.__matrixPoc.getClient().getRoom(roomId).findEventById(id); const b = window.__matrixPoc.getDisplayBody(ev); return b.isEdited && b.text === 'Reply from alice (edited)'; }, { roomId, id: sentId }));
  check('edit of a thread reply applies (getDisplayBody isEdited + new text)', edited);
  check('edited text rendered in the thread row', await waitFor(async () => (await page.getByTestId('thread-message-list').locator(`[data-testid="message-${sentId}"]`).textContent()).includes('(edited)')));

  // Threaded receipt clears the per-thread unread count.
  await page.evaluate(({ roomId, rootId }) => window.__matrixPoc.actions.markThreadRead(roomId, rootId), { roomId, rootId });
  const cleared = await waitFor(async () => page.evaluate(({ roomId, rootId }) => window.__matrixPoc.getClient().getRoom(roomId).getThreadUnreadNotificationCount(rootId) === 0, { roomId, rootId }), { timeout: 8000 });
  check('markThreadRead clears the thread unread count after sync', cleared);
  const receiptBody = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(sentId)}`, { token: bob.token }).then(() => null).catch(() => null);
  void receiptBody;

  // replyTo + threadRoot is rejected before anything is sent (AC-T2-3).
  const conflict = await page.evaluate(({ roomId, rootId, id }) => window.__matrixPoc.actions.sendText(roomId, 'nope', { threadRoot: rootId, replyTo: id }).then(() => null, (e) => e.name), { roomId, rootId, id: sentId });
  check('sendText rejects replyTo + threadRoot (ThreadReplyConflictError)', conflict === 'ThreadReplyConflictError', String(conflict));

  // Redacting a thread reply: the SDK moves it into the main timeline; the store guard keeps it out of the channel.
  await page.evaluate(({ roomId, id }) => window.__matrixPoc.actions.redactEvent(roomId, id), { roomId, id: bobReply.event_id });
  const redacted = await waitFor(async () => page.evaluate(({ roomId, id }) => window.__matrixPoc.getClient().getRoom(roomId).findEventById(id)?.isRedacted() === true, { roomId, id: bobReply.event_id }));
  check('redaction of a thread reply applied', redacted);
  await sleep(400);
  const guard = await page.evaluate(({ roomId, id }) => {
    const p = window.__matrixPoc;
    const room = p.getClient().getRoom(roomId);
    return {
      sdkMovedToMain: room.getLiveTimeline().getEvents().some((e) => e.getId() === id),
      inStoreMain: (p.timeline.getState().eventsByRoom[roomId] ?? []).some((e) => e.getId() === id),
      guarded: p.isRedactedThreadReply ? p.isRedactedThreadReply(roomId, id) : null,
    };
  }, { roomId, id: bobReply.event_id });
  check('redacted thread reply is NOT in the store main snapshot (SDK moved it to the live timeline)', !guard.inStoreMain, JSON.stringify(guard));
  check('redacted thread reply is NOT rendered in message-list', (await page.getByTestId('message-list').locator(`[data-testid="message-${bobReply.event_id}"]`).count()) === 0);

  // Close: member panel returns.
  await page.getByTestId('thread-close').click();
  await page.getByTestId('thread-panel').waitFor({ state: 'detached', timeout: 5000 });
  check('thread-close hides the panel and restores the member panel', await page.getByTestId('member-list').isVisible().catch(() => false));
  check('app-shell[data-thread-open=false]', (await page.getByTestId('app-shell').getAttribute('data-thread-open')) === 'false');

  // Room switch closes the thread.
  await page.evaluate((id) => window.__matrixPoc.openThread(id), rootId);
  await page.getByTestId('thread-panel').waitFor();
  const otherRoom = await page.evaluate(() => Object.keys(window.__matrixPoc.rooms.getState().roomsById).find((id) => !window.__matrixPoc.rooms.getState().roomsById[id].isSpace && id !== window.__matrixPoc.rooms.getState().selectedRoomId));
  await page.evaluate((id) => window.__matrixPoc.rooms.getState().selectRoom(id), otherRoom);
  await page.getByTestId('thread-panel').waitFor({ state: 'detached', timeout: 5000 });
  check('room switch closes the thread', true);
  check('no console/page errors on desktop (msc4143 probe 404 excluded)', errors.all().length === 0, errors.all().slice(0, 3).join(' | '));
  await desktop.close();

  // ======================================================================== phone (Pixel 7)
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const ppage = await phone.newPage();
  const perrors = collectErrors(ppage);
  await login(ppage);
  check('phone layout', (await ppage.getByTestId('app-shell').getAttribute('data-layout')) === 'phone');
  await ppage.evaluate((id) => window.__matrixPoc.openThread(id), rootId);
  await ppage.getByTestId('thread-panel').waitFor({ timeout: 10_000 });
  const vp = ppage.viewportSize();
  const pbox = await ppage.getByTestId('thread-panel-container').boundingBox();
  const headerBox = await ppage.getByTestId('channel-header').boundingBox().catch(() => null);
  check('phone: thread covers the conversation width', !!pbox && Math.round(pbox.width) === vp.width, `${Math.round(pbox?.width ?? 0)} / ${vp.width}`);
  check('phone: thread sits below the channel header', !!pbox && (!headerBox || pbox.y >= headerBox.y + headerBox.height - 1) && pbox.y + pbox.height >= vp.height - 1, `y ${Math.round(pbox?.y ?? 0)} h ${Math.round(pbox?.height ?? 0)}`);
  // Playwright's isVisible ignores overlap; hit-test the centre of the covered composer instead.
  check('phone: the thread layer covers the conversation composer (hit test)', await ppage.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer-input"]');
    if (!composer) return false;
    const r = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && !!hit.closest('[data-testid="thread-panel-container"]');
  }));
  check('phone: covered conversation is inert + aria-hidden', await ppage.evaluate(() => { const el = document.querySelector('[data-testid="thread-panel-container"]').previousElementSibling; return el.inert === true && el.getAttribute('aria-hidden') === 'true'; }));
  await ppage.screenshot({ path: path.join(SHOTS, 'phase3-thread-shell-phone.png') });
  console.log('saved docs/screenshots/phase3-thread-shell-phone.png');
  await ppage.evaluate(() => window.__matrixPoc.layout.getState().openNav());
  await sleep(400);
  check('phone: nav drawer opens over the thread', (await ppage.getByTestId('nav-drawer').getAttribute('data-open')) === 'true' && (await ppage.getByTestId('channel-sidebar').isVisible()));
  await ppage.evaluate(() => window.__matrixPoc.layout.getState().closeDrawers());
  // Android back order: thread first, then drawers.
  const back = await ppage.evaluate(() => {
    const first = window.__matrixPoc.threads.getState().closeThread() || window.__matrixPoc.layout.getState().closeDrawers();
    const second = window.__matrixPoc.threads.getState().closeThread() || window.__matrixPoc.layout.getState().closeDrawers();
    return { first, second, open: window.__matrixPoc.threads.getState().openThreadRootId };
  });
  check('phone: back closes the thread first, then nothing left (minimise)', back.first === true && back.second === false && back.open === null);
  await ppage.getByTestId('thread-panel').waitFor({ state: 'detached', timeout: 5000 });
  check('phone: conversation visible again after closing', await ppage.getByTestId('composer-input').isVisible().catch(() => false));
  check('no console/page errors on phone (msc4143 probe 404 excluded)', perrors.all().length === 0, perrors.all().slice(0, 3).join(' | '));
  await phone.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
