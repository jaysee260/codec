#!/usr/bin/env node
/**
 * Advisor probe: thread support on this Synapse. Creates a throwaway private room as alice, posts a
 * root + a bob reply + an alice reply (spec fallback shape), then inspects:
 *   GET /v1/rooms/{id}/threads?include=all|participated   (list + paging token)
 *   GET /v3/rooms/{id}/messages                            (unsigned.m.relations.m.thread on the root)
 *   GET /v3/sync (initial, timeline limit 10)              (same bundle in /sync)
 *   GET /v1/rooms/{id}/relations/{root}/m.thread           (what the SDK paginates threads with)
 * Both users leave + forget the room at the end. Run: node docs/advisor/thread-probe.mjs
 */
const HS = process.env.HS_URL ?? 'http://127.0.0.1:8008';
const j = async (method, path, tok, body) => {
  const r = await fetch(HS + path, { method, headers: { ...(tok && { authorization: `Bearer ${tok}` }), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const login = async (user) => (await j('POST', '/_matrix/client/v3/login', null, { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: 'password123', initial_device_display_name: 'advisor-thread-probe' })).access_token;
const txn = () => `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const send = (tok, room, content) => j('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn()}`, tok, content);
const reply = (root, latest, body) => ({ msgtype: 'm.text', body, 'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: latest } } });

const alice = await login('alice'), bob = await login('bob');
const { room_id: room } = await j('POST', '/_matrix/client/v3/createRoom', alice, { room_version: '11', name: 'advisor-thread-probe', preset: 'private_chat', invite: ['@bob:localhost'] });
await j('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/join`, bob);
const root = (await send(alice, room, { msgtype: 'm.text', body: 'thread root' })).event_id;
const r1 = (await send(bob, room, reply(root, root, 'bob reply 1'))).event_id;
const r2 = (await send(alice, room, reply(root, r1, 'alice reply 2'))).event_id;
const enc = encodeURIComponent(room);
const all = await j('GET', `/_matrix/client/v1/rooms/${enc}/threads?include=all&limit=1`, alice);
const mine = await j('GET', `/_matrix/client/v1/rooms/${enc}/threads?include=participated`, bob);
const msgs = await j('GET', `/_matrix/client/v3/rooms/${enc}/messages?dir=b&limit=10`, alice);
const rootInMessages = msgs.chunk.find((e) => e.event_id === root);
const sync = await j('GET', `/_matrix/client/v3/sync?filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 10 } } }))}&timeout=0`, bob);
const rootInSync = sync.rooms.join[room]?.timeline.events.find((e) => e.event_id === root);
const rel = await j('GET', `/_matrix/client/v1/rooms/${enc}/relations/${encodeURIComponent(root)}/m.thread?dir=b&limit=10`, alice);
console.log(JSON.stringify({
  room, root, replies: [r1, r2],
  threads_all: { count: all.chunk.length, ids: all.chunk.map((e) => e.event_id), next_batch: all.next_batch ?? null, bundle: all.chunk[0]?.unsigned?.['m.relations'] },
  threads_participated_as_bob: all && { count: mine.chunk.length, bundle_current_user_participated: mine.chunk[0]?.unsigned?.['m.relations']?.['m.thread']?.current_user_participated },
  messages_root_bundle: rootInMessages?.unsigned?.['m.relations'],
  sync_root_bundle_as_bob: rootInSync?.unsigned?.['m.relations'],
  sync_timeline_contains_replies: sync.rooms.join[room]?.timeline.events.filter((e) => e['content']?.['m.relates_to']?.rel_type === 'm.thread').map((e) => e.event_id),
  relations_m_thread: { ids: rel.chunk.map((e) => e.event_id), next_batch: rel.next_batch ?? null, relation_of_first: rel.chunk[0]?.content['m.relates_to'] },
}, null, 2));
for (const tok of [alice, bob]) { await j('POST', `/_matrix/client/v3/rooms/${enc}/leave`, tok); await j('POST', `/_matrix/client/v3/rooms/${enc}/forget`, tok); await j('POST', '/_matrix/client/v3/logout', tok); }
