#!/usr/bin/env node
/**
 * Post a thread to a room through the client-server API (Phase 3; QA fixture; demo prep). The root is sent by
 * alice, the replies alternate bob / carol and carry exactly the spec relation the client sends
 * (docs/CORE_API.md "Threads", "Wire shapes"):
 *
 *   "m.relates_to": { "rel_type": "m.thread", "event_id": "<root>", "is_falling_back": true,
 *                     "m.in_reply_to": { "event_id": "<previous reply, or the root for the first one>" } }
 *
 *   npm run thread:sample                                   # alice root + 3 replies (bob, carol, bob) in #dev:localhost
 *   npm run thread:sample -- --room "#general:localhost" --replies 5
 *   npm run thread:sample -- --as bob --room '#general:localhost' --root '$rootEventId' --replies 1   # reply to an existing root
 *   node scripts/send-thread-sample.mjs --room '!abc:localhost' --replies 1 --json seed/thread-sample.json
 *   node scripts/send-thread-sample.mjs --root-as bob --reply-as carol,dave --body "custom root text"
 *
 * After sending, the root is read back (`/event`) and the thread list (`/v1/rooms/{id}/threads`) is queried to
 * validate the server-side aggregation: `unsigned.m.relations.m.thread = { count, current_user_participated,
 * latest_event }`. The ids are printed as JSON and written to --json (default seed/thread-sample.json) so QA and
 * scripts/verify-thread-shell.mjs can find the thread.
 *
 * Environment: HS_URL (http://localhost:8008), PASSWORD (password123).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HS = (process.env.HS_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
const PASSWORD = process.env.PASSWORD ?? 'password123';

const args = process.argv.slice(2);
const value = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const roomArg = value('--room', '#dev:localhost');
const replyCount = Math.max(0, Number(value('--replies', '3')));
const rootAs = value('--root-as', 'alice');
/** Reply sender(s), round-robin. `--as bob` (docs/archive/PHASE3_TICKETS.md) is the same as `--reply-as bob`. */
const replyAs = (value('--reply-as') ?? value('--as') ?? 'bob,carol').split(',').map((s) => s.trim()).filter(Boolean);
/** Existing root event id: reply to it instead of posting a new root. */
const existingRoot = value('--root');
const rootBody = value('--body');
const outJson = value('--json', path.join(ROOT, 'seed', 'thread-sample.json'));

const REPLY_BODIES = [
  'First reply in the thread.',
  'Second one, still in the thread - the main timeline should not show this.',
  'Third reply, from the other side of the conversation.',
  'Fourth: keep it in the thread.',
  'Fifth and counting.',
];

// ---------------------------------------------------------------------------
// Matrix API (plain fetch, like seed/seed.ts and scripts/send-voice-sample.mjs)
// ---------------------------------------------------------------------------

async function api(method, endpoint, { token, body, query } = {}) {
  const url = new URL(HS + endpoint);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 10; attempt++) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text };
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(json.retry_after_ms ?? 1000)));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status} ${json.errcode ?? ''} ${json.error ?? text}`);
    return json;
  }
  throw new Error(`${method} ${endpoint}: still rate limited`);
}

let txnCounter = 0;
const txnId = () => `thread-${Date.now()}-${txnCounter++}`;

async function login(user) {
  const r = await api('POST', '/_matrix/client/v3/login', {
    body: { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: PASSWORD, initial_device_display_name: 'send-thread-sample' },
  });
  return { user, userId: r.user_id, token: r.access_token };
}

async function send(session, roomId, content) {
  const r = await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId()}`, { token: session.token, body: content });
  return r.event_id;
}

/** The exact reply content the client sends (`sendText(roomId, body, { threadRoot })`). */
export function threadReplyContent(body, rootId, latestId) {
  return {
    msgtype: 'm.text',
    body,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: rootId,
      is_falling_back: true,
      'm.in_reply_to': { event_id: latestId },
    },
  };
}

async function main() {
  const users = {};
  for (const name of new Set([rootAs, ...replyAs])) users[name] = await login(name);
  console.log(`logged in: ${Object.values(users).map((u) => u.userId).join(', ')}`);

  let roomId = roomArg;
  if (roomArg.startsWith('#')) {
    const r = await api('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(roomArg)}`);
    roomId = r.room_id;
  }
  for (const u of Object.values(users)) {
    try {
      await api('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, { token: u.token, body: {} });
    } catch (e) {
      console.log(`join skipped for ${u.userId}: ${e.message}`);
    }
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const root = users[rootAs];
  let rootId = existingRoot;
  let rootSender = root.userId;
  let priorCount = 0;
  if (rootId) {
    const existing = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rootId)}`, { token: root.token });
    rootSender = existing.sender;
    priorCount = existing.unsigned?.['m.relations']?.['m.thread']?.count ?? 0;
    console.log(`replying to existing root ${rootId} by ${rootSender} (${priorCount} replies so far)`);
  } else {
    rootId = await send(root, roomId, {
      msgtype: 'm.text',
      body: rootBody ?? `Thread sample (${stamp}): reply in the thread, not here.`,
    });
    console.log(`root ${rootId} by ${root.userId}`);
  }

  const replies = [];
  const latestBefore = existingRoot
    ? (await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rootId)}`, { token: root.token })).unsigned?.['m.relations']?.['m.thread']?.latest_event?.event_id
    : undefined;
  let latest = latestBefore ?? rootId;
  for (let i = 0; i < replyCount; i++) {
    const who = users[replyAs[i % replyAs.length]];
    const body = `${REPLY_BODIES[i % REPLY_BODIES.length]}${i >= REPLY_BODIES.length ? ` (#${i + 1})` : ''}`;
    const id = await send(who, roomId, threadReplyContent(body, rootId, latest));
    replies.push({ eventId: id, sender: who.userId, body, inReplyTo: latest });
    console.log(`reply ${i + 1} ${id} by ${who.userId} (m.in_reply_to ${latest})`);
    latest = id;
  }

  // Read back + validate the server-side aggregation.
  const viewer = users[rootAs];
  const rootBack = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rootId)}`, { token: viewer.token });
  const bundle = rootBack.unsigned?.['m.relations']?.['m.thread'];
  const list = await api('GET', `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/threads`, { token: viewer.token, query: { include: 'all', limit: '50' } });
  const listed = list.chunk?.some((e) => e.event_id === rootId) ?? false;
  const lastReply = replies[replies.length - 1];
  const replyBack = lastReply
    ? await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(lastReply.eventId)}`, { token: viewer.token })
    : null;
  const rel = replyBack?.content?.['m.relates_to'];
  const expectedCount = priorCount + replyCount;
  const checks = {
    bundlePresent: expectedCount === 0 || !!bundle,
    bundleCount: expectedCount === 0 || bundle?.count === expectedCount,
    bundleLatest: replyCount === 0 || bundle?.latest_event?.event_id === lastReply.eventId,
    // Spec: the viewer "participated" when they sent the root or any reply; the viewer here is the root sender.
    bundleParticipated: existingRoot ? true : replyCount === 0 || bundle?.current_user_participated === true,
    listedInThreads: expectedCount === 0 || listed,
    replyRelation: replyCount === 0 || (rel?.rel_type === 'm.thread' && rel.event_id === rootId && rel.is_falling_back === true && rel['m.in_reply_to']?.event_id === lastReply.inReplyTo),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);

  const summary = {
    ok: failed.length === 0,
    failedChecks: failed,
    roomId,
    roomAlias: roomArg.startsWith('#') ? roomArg : undefined,
    rootId,
    rootSender,
    replyIds: replies.map((r) => r.eventId),
    replies,
    bundle: bundle ?? null,
    listedInThreads: listed,
    sentAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (outJson) {
    mkdirSync(path.dirname(outJson), { recursive: true });
    writeFileSync(outJson, JSON.stringify(summary, null, 2) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), outJson)}`);
  }
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
