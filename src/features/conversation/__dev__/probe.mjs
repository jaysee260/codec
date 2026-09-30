/** Throwaway: print the newest N events of a seeded room straight from the homeserver. */
import { readFileSync } from 'node:fs';

const HS = process.env.HS_URL ?? 'http://localhost:8008';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const roomKey = process.argv[2] ?? 'general';
const limit = Number(process.argv[3] ?? 35);

const login = await fetch(`${HS}/_matrix/client/v3/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: 'alice' }, password: 'password123' }),
}).then((r) => r.json());

const roomId = seed.rooms[roomKey];
const res = await fetch(
  `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
  { headers: { authorization: `Bearer ${login.access_token}` } },
).then((r) => r.json());

const events = [...res.chunk].reverse();
events.forEach((e, i) => {
  const c = e.content ?? {};
  const rel = c['m.relates_to'];
  const tag = rel?.rel_type ?? (rel?.['m.in_reply_to'] ? 'reply' : '');
  const label = e.type === 'm.reaction' ? `${rel?.key} -> ${rel?.event_id?.slice(0, 8)}` : (c.body ?? '').slice(0, 48);
  console.log(
    String(i).padStart(2, '0'),
    e.type.padEnd(16),
    (e.sender ?? '').padEnd(18),
    (c.msgtype ?? '').padEnd(8),
    tag.padEnd(10),
    e.event_id.slice(0, 10),
    JSON.stringify(label),
  );
});
const map = Object.entries(seed.events);
for (const [k, v] of map) {
  const idx = events.findIndex((e) => e.event_id === v);
  console.log(`seed ${k.padEnd(22)} -> index ${idx}`);
}
