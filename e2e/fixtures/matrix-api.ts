/**
 * Raw-fetch Matrix client-server helper for driving a *second* user during a test (QA-2).
 *
 *   const bob = await asUser('bob');
 *   await bob.send(roomId('general'), 'On my way');
 *
 * Deliberately not matrix-js-sdk: the helper must be independent of the code under test, so a bug
 * in the app's SDK wiring cannot make a test pass. Tokens are cached per user for the whole
 * process (workers: 1), every request retries on 429 honouring `retry_after_ms`.
 *
 * Sync notes learned from this homeserver (they shape the API below):
 *  - `m.typing` is only delivered on *incremental* syncs, never on an initial one, so typing
 *    assertions must go through `watchTyping()` which captures a `since` token up front.
 *  - `m.receipt` ephemeral IS returned on an initial sync (full current state), so `getReceipts()`
 *    can be a one-shot call.
 *  - `unread_notifications` on an initial sync is unreliable on this Synapse build, so unread is
 *    derived from receipts + timeline by `unreadFor()` instead of read from sync.
 */
import { HS_URL, PASSWORD, type UserKey } from './seed.ts';

const V3 = `${HS_URL}/_matrix/client/v3`;
const V1 = `${HS_URL}/_matrix/client/v1`;

const tokenCache = new Map<UserKey, { userId: string; token: string }>();
let txnCounter = 0;

function txnId(): string {
  txnCounter += 1;
  return `e2e-${Date.now()}-${txnCounter}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MatrixApiError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    readonly body: string,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} -> HTTP ${status}${errcode ? ` (${errcode})` : ''}: ${body}`);
    this.name = 'MatrixApiError';
  }
}

interface RequestOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Treat these statuses as a resolved `undefined` instead of throwing. */
  allow404?: boolean;
  timeoutMs?: number;
}

async function request<T>(method: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const full = qs.toString() ? `${url}?${qs}` : url;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(full, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });

    const text = await res.text();

    if (res.status === 429) {
      let waitMs = 500 * (attempt + 1);
      try {
        const parsed = JSON.parse(text) as { retry_after_ms?: number };
        if (typeof parsed.retry_after_ms === 'number') waitMs = parsed.retry_after_ms + 50;
      } catch {
        /* keep the backoff default */
      }
      await sleep(Math.min(waitMs, 5_000));
      continue;
    }

    if (res.status === 404 && opts.allow404) return undefined as T;

    if (!res.ok) {
      let errcode: string | undefined;
      try {
        errcode = (JSON.parse(text) as { errcode?: string }).errcode;
      } catch {
        /* non-JSON error body */
      }
      throw new MatrixApiError(res.status, errcode, text.slice(0, 400), method, full);
    }

    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new Error(`${method} ${full} still rate-limited after 6 attempts`);
}

export interface MatrixEventJson {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
  redacts?: string;
}

export interface HierarchyRoom {
  room_id: string;
  name?: string;
  topic?: string;
  join_rule?: string;
  guest_can_join?: boolean;
  children_state?: { state_key: string; content: { order?: string; via?: string[] } }[];
  room_type?: string;
}

/** Read receipts for a room: eventId -> userId -> { ts }. */
export type ReceiptMap = Record<string, Record<string, { ts?: number }>>;

export interface TypingWatcher {
  /** The most recent `m.typing` user_ids seen by this watcher (excludes nobody). */
  latest(): string[];
  /** Long-polls `/sync` until `predicate(userIds)` holds. Throws with the last seen set on timeout. */
  waitFor(predicate: (userIds: string[]) => boolean, timeoutMs?: number, label?: string): Promise<string[]>;
  /** Convenience: every listed user id is typing. */
  waitForTyping(userIds: string[], timeoutMs?: number): Promise<string[]>;
  /** Convenience: none of the listed user ids is typing. */
  waitForNotTyping(userIds: string[], timeoutMs?: number): Promise<string[]>;
}

export interface UnreadInfo {
  /** Messages after this user's read receipt that were not sent by them. */
  count: number;
  /** The event the user's `m.read` receipt currently points at, if any. */
  receiptEventId?: string;
  /** True when the receipt could not be located in the fetched window (count is then a lower bound). */
  approximate: boolean;
}

export interface ApiUser {
  readonly key: UserKey;
  readonly userId: string;
  readonly token: string;

  /** Send an `m.text` message. `extra` is merged into the content (relations, mentions, ...). */
  send(roomId: string, body: string, extra?: Record<string, unknown>): Promise<string>;
  /** Send an `m.text` message with an `org.matrix.custom.html` formatted body. */
  sendHtml(roomId: string, body: string, html: string, extra?: Record<string, unknown>): Promise<string>;
  /** Send an arbitrary event type (used for stickers/edits/etc). */
  sendEvent(roomId: string, type: string, content: Record<string, unknown>): Promise<string>;
  /** Put a state event (used to remove an `m.space.child` link when cleaning up). */
  sendStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<string>;
  /** `m.reaction` / `m.annotation` on a target event. */
  react(roomId: string, eventId: string, key: string): Promise<string>;
  /** Typing notification for this user (`on: false` clears it immediately). */
  typing(roomId: string, on: boolean, timeoutMs?: number): Promise<void>;
  redact(roomId: string, eventId: string, reason?: string): Promise<string>;
  /** Send an `m.read` receipt. NOTE: Synapse refuses to move a receipt backwards. */
  receipt(roomId: string, eventId: string): Promise<void>;
  /** All `m.read` receipts currently visible in the room. */
  getReceipts(roomId: string): Promise<ReceiptMap>;
  /** The event id `userId`'s `m.read` receipt points at, or undefined. */
  readReceiptOf(roomId: string, userId: string): Promise<string | undefined>;
  getEvent(roomId: string, eventId: string): Promise<MatrixEventJson>;
  /** `GET /_matrix/client/v1/rooms/{spaceId}/hierarchy` */
  hierarchy(spaceId: string): Promise<{ rooms: HierarchyRoom[] }>;
  invite(roomId: string, userId: string): Promise<void>;
  joinedMembers(roomId: string): Promise<Record<string, { display_name?: string; avatar_url?: string }>>;
  joinRoom(roomIdOrAlias: string): Promise<string>;
  leaveRoom(roomId: string): Promise<void>;
  forgetRoom(roomId: string): Promise<void>;

  /** Removes a member or a pending invite (`membership: invite`) from a room. */
  kick(roomId: string, userId: string, reason?: string): Promise<void>;
  /** `m.room.member` membership for a user in a room, or undefined when there is no member event. */
  membership(roomId: string, userId: string): Promise<string | undefined>;

  /** Newest-first page of room events (defaults to 200, unfiltered). */
  messages(roomId: string, limit?: number): Promise<MatrixEventJson[]>;
  /** Newest `m.room.message` whose body contains `text` (optionally from a specific sender). */
  findMessage(roomId: string, text: string, sender?: string): Promise<MatrixEventJson | undefined>;
  /** Newest `m.room.message` in the room. */
  lastMessage(roomId: string): Promise<MatrixEventJson | undefined>;
  /** Room state content, or undefined when the state event is absent. */
  stateEvent(roomId: string, type: string, stateKey?: string): Promise<Record<string, unknown> | undefined>;
  /** `m.direct` account data for this user. */
  directMap(): Promise<Record<string, string[]>>;

  /** Unread derived from receipts + timeline (see the module header for why not from `/sync`). */
  unreadFor(roomId: string, userId?: string): Promise<UnreadInfo>;
  /** Captures a `since` token now; later `waitFor*` calls long-poll from it. */
  watchTyping(roomId: string): Promise<TypingWatcher>;
}

/**
 * Would this event bump `notification_count` for `forUserId` under Synapse's default push rules?
 * Own messages, reactions, redactions and edits (`.m.rule.suppress_edits`) do not.
 */
function notifiesUser(event: MatrixEventJson, forUserId: string): boolean {
  if (event.type !== 'm.room.message') return false;
  if (event.sender === forUserId) return false;
  if (typeof event.content?.msgtype !== 'string') return false; // redacted body
  const relation = event.content['m.relates_to'] as { rel_type?: string } | undefined;
  return relation?.rel_type !== 'm.replace';
}

async function login(key: UserKey): Promise<{ userId: string; token: string }> {
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const res = await request<{ access_token: string; user_id: string }>('POST', `${V3}/login`, {
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: key },
      password: PASSWORD,
      initial_device_display_name: 'matrix-poc e2e',
    },
  });
  const entry = { userId: res.user_id, token: res.access_token };
  tokenCache.set(key, entry);
  return entry;
}

/** Logs in (cached) and returns a small action surface for that seeded user. */
export async function asUser(key: UserKey): Promise<ApiUser> {
  const { userId, token } = await login(key);
  const room = (id: string): string => encodeURIComponent(id);

  const api: ApiUser = {
    key,
    userId,
    token,

    async sendEvent(roomId, type, content) {
      const res = await request<{ event_id: string }>(
        'PUT',
        `${V3}/rooms/${room(roomId)}/send/${encodeURIComponent(type)}/${txnId()}`,
        { token, body: content },
      );
      return res.event_id;
    },

    async sendStateEvent(roomId, type, stateKey, content) {
      const res = await request<{ event_id: string }>(
        'PUT',
        `${V3}/rooms/${room(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
        { token, body: content },
      );
      return res.event_id;
    },

    send(roomId, body, extra) {
      return api.sendEvent(roomId, 'm.room.message', { msgtype: 'm.text', body, ...extra });
    },

    sendHtml(roomId, body, html, extra) {
      return api.sendEvent(roomId, 'm.room.message', {
        msgtype: 'm.text',
        body,
        format: 'org.matrix.custom.html',
        formatted_body: html,
        ...extra,
      });
    },

    react(roomId, eventId, key_) {
      return api.sendEvent(roomId, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: key_ },
      });
    },

    async typing(roomId, on, timeoutMs = 10_000) {
      await request('PUT', `${V3}/rooms/${room(roomId)}/typing/${encodeURIComponent(userId)}`, {
        token,
        body: on ? { typing: true, timeout: timeoutMs } : { typing: false },
      });
    },

    async redact(roomId, eventId, reason) {
      const res = await request<{ event_id: string }>(
        'PUT',
        `${V3}/rooms/${room(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId()}`,
        { token, body: reason ? { reason } : {} },
      );
      return res.event_id;
    },

    async receipt(roomId, eventId) {
      await request('POST', `${V3}/rooms/${room(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`, {
        token,
        body: {},
      });
    },

    async getReceipts(roomId) {
      const filter = JSON.stringify({
        room: {
          rooms: [roomId],
          timeline: { limit: 1 },
          ephemeral: { types: ['m.receipt'] },
        },
        presence: { types: [] },
        account_data: { types: [] },
      });
      const sync = await request<SyncResponse>('GET', `${V3}/sync`, {
        token,
        query: { filter, timeout: 0 },
      });
      const events = sync.rooms?.join?.[roomId]?.ephemeral?.events ?? [];
      const out: ReceiptMap = {};
      for (const ev of events) {
        if (ev.type !== 'm.receipt') continue;
        for (const [eventId, byType] of Object.entries(ev.content as Record<string, unknown>)) {
          const read = (byType as Record<string, Record<string, { ts?: number }>>)['m.read'];
          if (!read) continue;
          out[eventId] = { ...(out[eventId] ?? {}), ...read };
        }
      }
      return out;
    },

    async readReceiptOf(roomId, forUserId) {
      const receipts = await api.getReceipts(roomId);
      for (const [eventId, users] of Object.entries(receipts)) {
        if (users[forUserId]) return eventId;
      }
      return undefined;
    },

    getEvent(roomId, eventId) {
      return request<MatrixEventJson>(
        'GET',
        `${V3}/rooms/${room(roomId)}/event/${encodeURIComponent(eventId)}`,
        { token },
      );
    },

    hierarchy(spaceId) {
      return request<{ rooms: HierarchyRoom[] }>('GET', `${V1}/rooms/${room(spaceId)}/hierarchy`, {
        token,
        query: { limit: 50 },
      });
    },

    async invite(roomId, inviteeId) {
      await request('POST', `${V3}/rooms/${room(roomId)}/invite`, {
        token,
        body: { user_id: inviteeId },
      });
    },

    async joinedMembers(roomId) {
      const res = await request<{ joined: Record<string, { display_name?: string; avatar_url?: string }> }>(
        'GET',
        `${V3}/rooms/${room(roomId)}/joined_members`,
        { token },
      );
      return res.joined ?? {};
    },

    async joinRoom(roomIdOrAlias) {
      const res = await request<{ room_id: string }>(
        'POST',
        `${V3}/join/${encodeURIComponent(roomIdOrAlias)}`,
        { token, body: {} },
      );
      return res.room_id;
    },

    async leaveRoom(roomId) {
      await request('POST', `${V3}/rooms/${room(roomId)}/leave`, { token, body: {} });
    },

    async forgetRoom(roomId) {
      await request('POST', `${V3}/rooms/${room(roomId)}/forget`, { token, body: {} });
    },

    async kick(roomId, targetId, reason) {
      await request('POST', `${V3}/rooms/${room(roomId)}/kick`, {
        token,
        body: { user_id: targetId, ...(reason ? { reason } : {}) },
      });
    },

    async membership(roomId, targetId) {
      const content = await api.stateEvent(roomId, 'm.room.member', targetId);
      const value = content?.membership;
      return typeof value === 'string' ? value : undefined;
    },

    async messages(roomId, limit = 200) {
      const res = await request<{ chunk: MatrixEventJson[] }>('GET', `${V3}/rooms/${room(roomId)}/messages`, {
        token,
        query: { dir: 'b', limit },
      });
      return res.chunk ?? [];
    },

    async findMessage(roomId, text, sender) {
      const chunk = await api.messages(roomId);
      return chunk.find(
        (e) =>
          e.type === 'm.room.message' &&
          (sender === undefined || e.sender === sender) &&
          typeof e.content?.body === 'string' &&
          (e.content.body as string).includes(text),
      );
    },

    async lastMessage(roomId) {
      const chunk = await api.messages(roomId, 50);
      return chunk.find((e) => e.type === 'm.room.message');
    },

    stateEvent(roomId, type, stateKey = '') {
      return request<Record<string, unknown> | undefined>(
        'GET',
        `${V3}/rooms/${room(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
        { token, allow404: true },
      );
    },

    async directMap() {
      const res = await request<Record<string, string[]> | undefined>(
        'GET',
        `${V3}/user/${encodeURIComponent(userId)}/account_data/m.direct`,
        { token, allow404: true },
      );
      return res ?? {};
    },

    async unreadFor(roomId, forUserId = userId) {
      const receiptEventId = await api.readReceiptOf(roomId, forUserId);
      const chunk = await api.messages(roomId);
      const counts = (events: MatrixEventJson[]): number =>
        events.filter((e) => notifiesUser(e, forUserId)).length;
      if (!receiptEventId) {
        return { count: counts(chunk), receiptEventId: undefined, approximate: false };
      }
      // chunk is newest-first: everything before the receipt event is newer than it.
      const idx = chunk.findIndex((e) => e.event_id === receiptEventId);
      const newer = idx === -1 ? chunk : chunk.slice(0, idx);
      return { count: counts(newer), receiptEventId, approximate: idx === -1 };
    },

    async watchTyping(roomId) {
      const filter = JSON.stringify({
        room: {
          rooms: [roomId],
          timeline: { limit: 1 },
          ephemeral: { types: ['m.typing'] },
        },
        presence: { types: [] },
        account_data: { types: [] },
      });

      const first = await request<SyncResponse>('GET', `${V3}/sync`, {
        token,
        query: { filter, timeout: 0 },
      });
      let since = first.next_batch;
      let latest: string[] = [];

      const readTyping = (sync: SyncResponse): void => {
        for (const ev of sync.rooms?.join?.[roomId]?.ephemeral?.events ?? []) {
          if (ev.type !== 'm.typing') continue;
          const ids = (ev.content as { user_ids?: string[] }).user_ids;
          if (Array.isArray(ids)) latest = ids;
        }
      };

      const watcher: TypingWatcher = {
        latest: () => [...latest],

        async waitFor(predicate, timeoutMs = 8_000, label = 'typing predicate') {
          const deadline = Date.now() + timeoutMs;
          if (predicate(latest)) return [...latest];
          while (Date.now() < deadline) {
            const remaining = deadline - Date.now();
            const sync = await request<SyncResponse>('GET', `${V3}/sync`, {
              token,
              query: { filter, since, timeout: Math.max(200, Math.min(remaining, 2_500)) },
              timeoutMs: Math.min(remaining, 2_500) + 8_000,
            });
            since = sync.next_batch;
            readTyping(sync);
            if (predicate(latest)) return [...latest];
          }
          throw new Error(
            `${label} not satisfied within ${timeoutMs} ms in ${roomId}; last typing set seen as ${key}: [${latest.join(', ')}]`,
          );
        },

        waitForTyping(userIds, timeoutMs) {
          return watcher.waitFor(
            (ids) => userIds.every((u) => ids.includes(u)),
            timeoutMs,
            `typing includes [${userIds.join(', ')}]`,
          );
        },

        waitForNotTyping(userIds, timeoutMs) {
          return watcher.waitFor(
            (ids) => userIds.every((u) => !ids.includes(u)),
            timeoutMs,
            `typing excludes [${userIds.join(', ')}]`,
          );
        },
      };

      return watcher;
    },
  };

  return api;
}

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        ephemeral?: { events?: { type: string; content: unknown }[] };
        unread_notifications?: { notification_count?: number; highlight_count?: number };
      }
    >;
  };
}

/** Drops cached tokens (used by nothing in the suite today; handy when debugging auth). */
export function resetApiTokens(): void {
  tokenCache.clear();
}
