/**
 * Shared helpers for the Phase 4 GIF scripts (`send-gif-sample.mjs`, `verify-gif.mjs`): raw client-server API
 * calls, room alias resolution and the contract GIF message built by the client's own `buildGifContent`
 * (`src/lib/gif/message.ts`, imported with Node's native type stripping). Nothing here touches Playwright.
 */
import { randomUUID } from 'node:crypto';

export const HS = (process.env.HS_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
export const PASSWORD = process.env.PASSWORD ?? 'password123';

export async function api(method, endpoint, { token, body, raw } = {}) {
  const res = await fetch(HS + endpoint, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export async function login(user, device = 'gif-script') {
  const r = await api('POST', '/_matrix/client/v3/login', {
    body: { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: PASSWORD, initial_device_display_name: device },
  });
  return { userId: r.user_id, token: r.access_token };
}

export async function logout(session) {
  await api('POST', '/_matrix/client/v3/logout', { token: session.token }).catch(() => {});
}

/** `#alias:server` -> room id (joins when not a member); `!id` passes through. */
export async function resolveRoom(session, roomArg) {
  let roomId = roomArg;
  if (roomArg.startsWith('#')) {
    const r = await api('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(roomArg)}`, { token: session.token });
    roomId = r.room_id;
  }
  const joined = await api('GET', '/_matrix/client/v3/joined_rooms', { token: session.token });
  if (!joined.joined_rooms.includes(roomId)) await api('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, { token: session.token, body: {} });
  return roomId;
}

export async function sendContent(session, roomId, content) {
  const txn = `gif-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const r = await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, { token: session.token, body: content });
  return r.event_id;
}

export async function fetchEvent(session, roomId, eventId) {
  return api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, { token: session.token });
}

/** The client's own modules (type-stripped). */
export async function loadGifLib() {
  const [message, mock, klipy, fixtures] = await Promise.all([
    import('../../src/lib/gif/message.ts'),
    import('../../src/lib/gif/mock.ts'),
    import('../../src/lib/gif/klipy.ts'),
    import('../../src/lib/gif/mock-fixtures.ts'),
  ]);
  return { ...message, ...mock, ...klipy, ...fixtures };
}

/** Phase 3 thread relation, exactly as `actions.ts` builds it (fallback target = the root when unknown). */
export function threadRelation(rootId, latestReplyId = rootId) {
  return { rel_type: 'm.thread', event_id: rootId, is_falling_back: true, 'm.in_reply_to': { event_id: latestReplyId } };
}
