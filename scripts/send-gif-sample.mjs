#!/usr/bin/env node
/**
 * Post a contract GIF message through the client-server API (Phase 4, PRIN-16; demo prep "a GIF bob sent";
 * QA fixture). Builds the content with the client's own `buildGifContent` (src/lib/gif/message.ts) from the
 * mock catalogue, so the event is byte-for-byte what the picker sends (docs/PHASE4_ACCEPTANCE.md AC-G10-1).
 *
 *   npm run gif:sample                                   # bob -> #dev:localhost, mock-7 (Thumbs up)
 *   node scripts/send-gif-sample.mjs --id mock-3 --room '#general:localhost' --as alice   # demo room (team rule: scripts default to #dev)
 *   node scripts/send-gif-sample.mjs --root $eventId     # into a thread (Phase 3 relation)
 *   node scripts/send-gif-sample.mjs --origin http://192.168.1.20:5173   # fixture URLs for a phone on the LAN
 *
 * Prints JSON `{ roomId, eventId, content }` and exits 0. Environment: HS_URL (http://localhost:8008), PASSWORD.
 */
import { fetchEvent, loadGifLib, login, logout, resolveRoom, sendContent, threadRelation } from './lib/gif-api.mjs';

const args = process.argv.slice(2);
const value = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const user = value('--as', 'bob');
const roomArg = value('--room', '#dev:localhost');
const id = value('--id', 'mock-7');
const root = value('--root');
const origin = value('--origin', process.env.APP_ORIGIN ?? 'http://localhost:5173');

const lib = await loadGifLib();
const gif = lib.mockGifResults({ baseUrl: origin }).find((g) => g.id === id);
if (!gif) {
  console.error(`unknown fixture id ${id}; known: ${lib.MOCK_FIXTURES.map((f) => f.id).join(', ')}`);
  process.exit(2);
}

const session = await login(user, 'send-gif-sample');
try {
  const roomId = await resolveRoom(session, roomArg);
  const content = lib.buildGifContent(gif);
  if (root) content['m.relates_to'] = threadRelation(root);
  const eventId = await sendContent(session, roomId, content);
  const ev = await fetchEvent(session, roomId, eventId);
  const parsed = lib.parseGifContent(ev.content, { origin });
  if (!parsed || parsed.id !== id) throw new Error(`event ${eventId} does not parse back as a GIF message: ${JSON.stringify(ev.content)}`);
  console.log(JSON.stringify({ roomId, eventId, content }, null, 2));
} finally {
  await logout(session);
}
