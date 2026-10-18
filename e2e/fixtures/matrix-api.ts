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
 *
 * Phase 3 (QA-14) adds the thread surface — `sendThreadReply`, `getThreads`, `getRelations`,
 * `getThreadSummary`, `threadReceipt`/`threadReceiptOf` — and makes the Phase 1/2 receipt helpers
 * **main-timeline only**, because `threadSupport: true` gives every user one `m.read` position per
 * thread on top of `main`. See {@link ReceiptMap} and `notifiesUser`.
 */
import { readFileSync } from 'node:fs';
import { noteServerUse } from './run-log.ts';
import { HS_URL, PASSWORD, SERVER_NAME, type UserKey } from './seed.ts';

const V3 = `${HS_URL}/_matrix/client/v3`;
const V1 = `${HS_URL}/_matrix/client/v1`;

const tokenCache = new Map<UserKey, { userId: string; token: string }>();
let txnCounter = 0;
/** Bumped on every receipt read so each /sync misses Synapse's initial-sync response cache. */
let receiptNonce = 0;

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
  noteServerUse();
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

/**
 * Read receipts for a room: eventId -> userId -> `{ ts, thread_id }`.
 *
 * Phase 3 (QA-14): with `threadSupport: true` matrix-js-sdk sends a **threaded** receipt for every
 * position — `thread_id: "main"` for the room timeline and `thread_id: "$root"` for each thread — so
 * one user holds several `m.read` positions in the same room at once. `thread_id` is therefore part
 * of the data, not noise: `readReceiptOf`/`unreadFor` look at main only, `threadReceiptOf` at one
 * thread. A receipt posted by `ApiUser.receipt()` without a thread id has `thread_id: undefined`,
 * which counts as main (the spec's unthreaded receipt).
 */
export type ReceiptMap = Record<string, Record<string, ReceiptData>>;

export interface ReceiptData {
  ts?: number;
  /** `"main"`, a thread root id, or absent for an unthreaded receipt. */
  thread_id?: string;
}

/** True for the room ("main") timeline position: `thread_id` is `"main"` or absent. */
export function isMainReceipt(receipt: ReceiptData | undefined): boolean {
  return !!receipt && (receipt.thread_id === undefined || receipt.thread_id === 'main');
}

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
  /**
   * Send an `m.read` receipt. NOTE: Synapse refuses to move a receipt backwards.
   * `threadId` sends the Phase 3 threaded form (`{ thread_id }`): a thread root id for an in-thread
   * position, `'main'` for the room timeline. Omitted = the Phase 1 unthreaded receipt.
   */
  receipt(roomId: string, eventId: string, threadId?: string): Promise<void>;
  /** `POST m.read` on `eventId` with `{ thread_id: rootId }` (AC-T6-8 / the receipt contract). */
  threadReceipt(roomId: string, rootId: string, eventId: string): Promise<void>;
  /** All `m.read` receipts currently visible in the room, `thread_id` included. */
  getReceipts(roomId: string): Promise<ReceiptMap>;
  /**
   * The event id `userId`'s **main-timeline** `m.read` receipt points at, or undefined.
   * Threaded receipts (`thread_id` = a root id) are ignored — see {@link ReceiptMap}.
   */
  readReceiptOf(roomId: string, userId: string): Promise<string | undefined>;
  /** The event id `userId`'s receipt **for the thread `rootId`** points at, or undefined (AC-T6-8). */
  threadReceiptOf(roomId: string, userId: string, rootId: string): Promise<string | undefined>;
  /** Newest receipt position of `userId` whose receipt data passes `accept` (the two above build on it). */
  newestReceiptOf(
    roomId: string,
    userId: string,
    accept: (receipt: ReceiptData) => boolean,
  ): Promise<string | undefined>;
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
  /**
   * Newest-first events across several `/messages` pages, so a seeded event still resolves after
   * the devs (and this suite) have pushed hundreds of newer events into the room.
   */
  messagesDeep(roomId: string, maxPages?: number, pageSize?: number): Promise<MatrixEventJson[]>;
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

  /** Uploads bytes to the media repo and returns the `mxc://` uri (Phase 2, QA-8). */
  upload(bytes: Uint8Array, contentType: string, filename: string): Promise<string>;
  /**
   * Posts a voice message with the exact contract shape of docs/PHASE2_ACCEPTANCE.md
   * (QA-8; "bob's voice note" in the phone demo). See {@link SendVoiceOptions}.
   */
  sendVoice(roomId: string, opts?: SendVoiceOptions): Promise<SentVoice>;
  /** Downloads an `mxc://` uri through `/_matrix/media/v3/download` for magic-byte checks (AC-V2-3). */
  getMedia(mxc: string): Promise<DownloadedMedia>;

  /* ---------------------------------------------------------------- threads (Phase 3, QA-14) */

  /**
   * Posts a thread reply with the **exact** contract content of docs/PHASE3_ACCEPTANCE.md:
   *
   * ```json
   * { "msgtype": "m.text", "body": body,
   *   "m.relates_to": { "rel_type": "m.thread", "event_id": rootId,
   *                     "is_falling_back": true, "m.in_reply_to": { "event_id": latest ?? rootId } } }
   * ```
   *
   * `latest` is the newest reply already in the thread. Pass it explicitly when sending a run of
   * replies (the previous call's return value) — it saves a `/relations` round trip per reply, which
   * matters when a test needs 35+ of them. Omitted, the newest reply is read from `getRelations`
   * (falling back to the root for the first reply of a thread).
   */
  sendThreadReply(roomId: string, rootId: string, body: string, opts?: SendThreadReplyOptions): Promise<string>;
  /**
   * `GET /_matrix/client/v1/rooms/{roomId}/threads?include=all` — root events, **newest activity
   * first**, following `next_batch` up to `maxPages` (default 3, as `useRoomThreads` does).
   */
  getThreads(roomId: string, opts?: GetThreadsOptions): Promise<ThreadsPage>;
  /**
   * `GET /_matrix/client/v1/rooms/{roomId}/relations/{rootId}/m.thread?dir=b&limit=50` —
   * the thread's replies **newest first** (the direction the SDK paginates in). `oldestFirst`
   * reverses the whole walk, which is the order the panel must render.
   */
  getRelations(roomId: string, rootId: string, opts?: GetRelationsOptions): Promise<RelationsPage>;
  /**
   * The server's bundled thread summary on a root: `unsigned["m.relations"]["m.thread"]`, read from
   * `/event` (and from `/messages` as a fallback, because Synapse only bundles relations on some
   * paths for some event ages). `null` when the event carries no thread bundle.
   */
  getThreadSummary(roomId: string, rootId: string): Promise<ServerThreadSummary | null>;
  /** Alias of {@link getThreadSummary} under the docs/PHASE3_TICKETS.md name. */
  threadSummaryOf(roomId: string, rootId: string): Promise<ServerThreadSummary | null>;
  /** `GET /user/{me}/filter/{filterId}` — the sync filter the app registered (AC-T1-1). */
  getFilter(filterId: string): Promise<Record<string, unknown> | undefined>;
}

export interface SendThreadReplyOptions {
  /** `m.in_reply_to.event_id`. Default: the newest existing reply, else the root. */
  latest?: string;
  /** Extra top-level content keys merged into the message (e.g. `format`/`formatted_body`). */
  extra?: Record<string, unknown>;
}

export interface GetThreadsOptions {
  /** `all` (default) or `participated`. */
  include?: 'all' | 'participated';
  /** Server page size. Default 50. */
  limit?: number;
  /** How many `next_batch` pages to follow. Default 3 (what `useRoomThreads` does). */
  maxPages?: number;
}

export interface ThreadsPage {
  /** Root events, newest activity first. */
  chunk: MatrixEventJson[];
  /** Root event ids in the same order (the order `thread-list-item-*` must be in). */
  rootIds: string[];
  /** The token left over after `maxPages`, when the room has more threads. */
  nextBatch?: string;
}

export interface GetRelationsOptions {
  limit?: number;
  maxPages?: number;
  /** Return the replies oldest first (the order the panel renders). Default false = newest first. */
  oldestFirst?: boolean;
}

export interface RelationsPage {
  chunk: MatrixEventJson[];
  /** Reply event ids in `chunk` order. */
  replyIds: string[];
  nextBatch?: string;
}

/** `unsigned["m.relations"]["m.thread"]` as Synapse bundles it. */
export interface ServerThreadSummary {
  count: number;
  current_user_participated?: boolean;
  latest_event?: MatrixEventJson;
}

/** The `m.relates_to` every thread reply must carry (docs/PHASE3_ACCEPTANCE.md). */
export interface ThreadRelatesTo {
  rel_type: string;
  event_id: string;
  is_falling_back?: boolean;
  'm.in_reply_to'?: { event_id?: string };
}

/**
 * `m.relates_to` of an event as fetched from the API, typed for field-by-field assertions
 * (AC-T2-1/2: `rel_type`, `event_id`, `is_falling_back`, `m.in_reply_to.event_id`).
 */
export function threadRelationOf(event: MatrixEventJson | undefined): ThreadRelatesTo | undefined {
  const relation = event?.content?.['m.relates_to'] as ThreadRelatesTo | undefined;
  return relation && typeof relation.rel_type === 'string' ? relation : undefined;
}

/** True for any event whose relation is `m.thread`, whatever `is_falling_back` says (the reading rule). */
export function isThreadReplyJson(event: MatrixEventJson): boolean {
  return threadRelationOf(event)?.rel_type === 'm.thread';
}

/* ------------------------------------------------------------------ voice messages (Phase 2) */

export interface SendVoiceOptions {
  /** Audio length in ms. Drives the generated WAV and `info.duration`. Default 1500 (AC-V4-1). */
  durationMs?: number;
  /** Override the waveform (AC-V4-1 wants 50 hand-made samples). Default: computed from the PCM, 100 samples. */
  waveform?: number[] | null;
  /** Container type announced in the event. Default `audio/wav` (what the generated bytes really are). */
  mimetype?: string;
  /** Upload these bytes instead of a generated WAV (the only way to post webm/ogg/mp4 from Node). */
  bytes?: Uint8Array;
  /** Read the bytes from this file instead (e.g. `e2e/fixtures/test-voice.wav`). */
  file?: string;
  /**
   * Skip the upload and point the event at this `mxc://` uri. `'bogus'` mints a well-formed uri that
   * the media repo has never heard of — the AC-V5-4 / `voice-error` path.
   */
  url?: string | 'bogus';
  /** `false` omits `org.matrix.msc3245.voice` so the event is a plain audio file (AC-V4-3). */
  voice?: boolean;
  /** `false` omits the whole `org.matrix.msc1767.audio` block (no waveform, no duration). */
  msc1767?: boolean;
  /** Extra top-level content keys (e.g. `m.relates_to`). */
  extra?: Record<string, unknown>;
}

export interface SentVoice {
  eventId: string;
  mxc: string;
  mimetype: string;
  durationMs: number;
  waveform: number[];
  size: number;
  /** The exact content that was sent, for field-by-field comparison. */
  content: Record<string, unknown>;
}

export interface DownloadedMedia {
  status: number;
  bytes: Uint8Array;
  contentType: string;
  /** First 8 bytes as uppercase hex pairs, e.g. `'1A 45 DF A3 ...'`. */
  magicHex: string;
  /** `'webm' | 'ogg' | 'mp4' | 'wav' | 'unknown'` from the magic bytes alone (AC-V2-3). */
  container: MediaContainer;
}

export type MediaContainer = 'webm' | 'ogg' | 'mp4' | 'wav' | 'unknown';

/** mimetype -> the container its magic bytes must announce (AC-V2-3). */
export const CONTAINER_FOR_MIMETYPE: Record<string, MediaContainer> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/**
 * Container from the leading bytes: `1A 45 DF A3` EBML (WebM/Matroska), `OggS`, `ftyp` at offset 4
 * (ISO-BMFF / MP4), `RIFF....WAVE`.
 */
export function detectContainer(bytes: Uint8Array): MediaContainer {
  const ascii = (from: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(from, from + len));
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }
  if (bytes.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (bytes.length >= 8 && ascii(4, 4) === 'ftyp') return 'mp4';
  return 'unknown';
}

const EXTENSION_FOR_MIMETYPE: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/mpeg': 'mp3',
};

/**
 * 16 kHz mono 16-bit PCM WAV of `durationMs` (a short melody with gaps, so the waveform is not flat).
 * Byte-identical to `scripts/send-voice-sample.mjs` for the same input, on purpose: the fixture and the
 * Principal's demo-prep script must produce the same artefact.
 */
export function generateWav(durationMs: number, sampleRate = 16_000): Uint8Array {
  const total = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const pcm = new Int16Array(total);
  const notes = [440, 0, 523.25, 587.33, 0, 659.25, 0, 783.99, 659.25, 0, 523.25, 440];
  const noteLen = total / notes.length;
  for (let i = 0; i < total; i += 1) {
    const n = Math.min(notes.length - 1, Math.floor(i / noteLen));
    const f = notes[n];
    if (!f) continue;
    const t = i / sampleRate;
    const pos = (i - n * noteLen) / noteLen;
    const env = Math.sin(Math.PI * pos) ** 0.6 * (0.35 + (0.45 * ((n * 7) % 5)) / 4);
    const s = Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * env * 32767)));
  }
  const dataBytes = pcm.length * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) buf[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  buf.set(new Uint8Array(pcm.buffer), 44);
  return buf;
}

/** `{ samples, sampleRate, durationMs }` from a 16-bit PCM WAV (mirrors `scripts/send-voice-sample.mjs`). */
export function parseWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number; durationMs: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (from: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(from, from + len));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let dataFrom = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.length) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(off + 8, true),
        channels: view.getUint16(off + 10, true),
        sampleRate: view.getUint32(off + 12, true),
        bits: view.getUint16(off + 22, true),
      };
    }
    if (id === 'data') {
      dataFrom = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataFrom < 0) throw new Error('WAV without fmt/data chunks');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM WAV is supported');
  const frames = Math.floor(dataLen / (2 * fmt.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c += 1) {
      acc += view.getInt16(dataFrom + (i * fmt.channels + c) * 2, true) / 32768;
    }
    samples[i] = acc / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate, durationMs: Math.round((frames / fmt.sampleRate) * 1000) };
}

/** Peak per bucket, normalised so the loudest bucket is 1024 — the same algorithm as `src/lib/audio`. */
export function waveformFromSamples(samples: Float32Array, buckets = 100): number[] {
  const peaks = new Array<number>(buckets).fill(0);
  const n = samples.length;
  let loudest = 0;
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / buckets));
    let peak = 0;
    for (let i = start; i < end && i < n; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
    peaks[b] = peak;
    loudest = Math.max(loudest, peak);
  }
  const scale = loudest > 0 ? 1 / loudest : 1;
  return peaks.map((p) => Math.round(Math.min(1, p * scale) * 1024));
}

/**
 * Would this event bump the **main-timeline** `notification_count` for `forUserId` under Synapse's
 * default push rules? Own messages, reactions, redactions and edits (`.m.rule.suppress_edits`) do not.
 *
 * Phase 3: neither do **thread replies**. With `threadSupport: true` Synapse reports them under
 * `unread_thread_notifications` and the app's room badge is `getRoomUnreadNotificationCount(Total)`,
 * i.e. main only (docs/PHASE3_PLAN.md "Room badges"). `/messages` still returns thread replies in the
 * room chunk, so without this they would be counted here and `unreadFor` would drift above the badge
 * the moment this suite leaves a thread reply in a seeded room.
 */
function notifiesUser(event: MatrixEventJson, forUserId: string): boolean {
  if (event.type !== 'm.room.message') return false;
  if (event.sender === forUserId) return false;
  if (typeof event.content?.msgtype !== 'string') return false; // redacted body
  const relation = event.content['m.relates_to'] as { rel_type?: string } | undefined;
  return relation?.rel_type !== 'm.replace' && relation?.rel_type !== 'm.thread';
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

    async receipt(roomId, eventId, threadId) {
      await request('POST', `${V3}/rooms/${room(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`, {
        token,
        body: threadId ? { thread_id: threadId } : {},
      });
    },

    threadReceipt(roomId, rootId, eventId) {
      return api.receipt(roomId, eventId, rootId);
    },

    async getReceipts(roomId) {
      // `account_data.limit` is a per-call nonce, and it is load-bearing: Synapse caches *initial*
      // /sync responses for ~2 minutes keyed by (user, device, since, filter, timeout), so polling
      // this endpoint with a constant filter replays a pre-receipt snapshot and a receipt that has
      // already landed stays invisible for the whole poll (BUG/not-a-bug: AC-B7-3, AC-B7-4, demo
      // step 2 — verified against this homeserver). A distinct filter per call misses the cache.
      // It cannot drop receipts: `account_data.types: []` already excludes account data entirely.
      receiptNonce += 1;
      const filter = JSON.stringify({
        room: {
          rooms: [roomId],
          timeline: { limit: 1 },
          ephemeral: { types: ['m.receipt'] },
        },
        presence: { types: [] },
        account_data: { types: [], limit: receiptNonce },
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
          const read = (byType as Record<string, Record<string, ReceiptData>>)['m.read'];
          if (!read) continue;
          out[eventId] = { ...(out[eventId] ?? {}), ...read };
        }
      }
      return out;
    },

    /**
     * Newest receipt position of `forUserId` that {@link accept}s, by `ts`.
     *
     * A user holds several `m.read` positions in one room at once: matrix-js-sdk sends a threaded
     * receipt per timeline (`thread_id: "main"` plus one per thread) and `ApiUser.receipt()` posts
     * unthreaded ones; Synapse keeps all of them in the room's `m.receipt` event. Taking whichever
     * key `Object.entries` yields first returns an arbitrary — often older, or another thread's —
     * position, so filter first and then pick the newest by `ts`.
     */
    async newestReceiptOf(roomId, forUserId, accept) {
      const receipts = await api.getReceipts(roomId);
      let newest: { eventId: string; ts: number } | undefined;
      for (const [eventId, users] of Object.entries(receipts)) {
        const receipt = users[forUserId];
        if (!receipt || !accept(receipt)) continue;
        const ts = receipt.ts ?? 0;
        if (!newest || ts > newest.ts) newest = { eventId, ts };
      }
      return newest?.eventId;
    },

    readReceiptOf(roomId, forUserId) {
      // Main timeline only (QA-14): after the `threadSupport` flip alice also holds a receipt per
      // thread, and those are *newer* than her main one, so an unfiltered "newest by ts" would
      // report a thread position for every main-timeline criterion (AC-B7-3, AC-A5, unreadFor).
      return api.newestReceiptOf(roomId, forUserId, isMainReceipt);
    },

    threadReceiptOf(roomId, forUserId, rootId) {
      return api.newestReceiptOf(roomId, forUserId, (r) => r.thread_id === rootId);
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

    async messagesDeep(roomId, maxPages = 10, pageSize = 200) {
      const out: MatrixEventJson[] = [];
      let from: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const res = await request<{ chunk?: MatrixEventJson[]; end?: string }>(
          'GET',
          `${V3}/rooms/${room(roomId)}/messages`,
          { token, query: { dir: 'b', limit: pageSize, from } },
        );
        const chunk = res.chunk ?? [];
        out.push(...chunk);
        if (chunk.length === 0 || !res.end) break;
        from = res.end;
      }
      return out;
    },

    async findMessage(roomId, text, sender) {
      const chunk = await api.messagesDeep(roomId);
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

    // ------------------------------------------------------------ media / voice (Phase 2)

    async upload(bytes, contentType, filename) {
      // `request()` is JSON-only; a media upload needs the raw body and its own content-type.
      const url = `${HS_URL}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
          body: bytes as unknown as BodyInit,
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
        if (!res.ok) throw new MatrixApiError(res.status, undefined, text.slice(0, 400), 'POST', url);
        const body = JSON.parse(text) as { content_uri?: string };
        if (!body.content_uri) throw new Error(`upload returned no content_uri: ${text.slice(0, 200)}`);
        return body.content_uri;
      }
      throw new Error(`upload still rate-limited after 6 attempts`);
    },

    async sendVoice(roomId, opts = {}) {
      const mimetype = opts.mimetype ?? 'audio/wav';
      const ext = EXTENSION_FOR_MIMETYPE[mimetype] ?? 'bin';
      const name = `Voice message.${ext}`;

      let bytes: Uint8Array;
      let durationMs = opts.durationMs ?? 1500;
      let waveform: number[];

      if (opts.bytes || opts.file) {
        bytes = opts.bytes ?? new Uint8Array(readFileSync(opts.file!));
      } else {
        bytes = generateWav(durationMs);
      }

      if (opts.waveform !== undefined && opts.waveform !== null) {
        waveform = opts.waveform;
      } else if (detectContainer(bytes) === 'wav') {
        const wav = parseWav(bytes);
        // The WAV itself is the source of truth for the duration when we did not synthesise it.
        if (opts.durationMs === undefined) durationMs = wav.durationMs;
        waveform = waveformFromSamples(wav.samples);
      } else {
        // Node cannot decode webm/ogg/mp4; a synthetic envelope keeps the waveform non-flat.
        waveform = Array.from({ length: 100 }, (_, i) => Math.round(((Math.sin(i / 4) + 1) / 2) * 700 + 100));
      }

      let mxc: string;
      let size = bytes.length;
      if (opts.url === 'bogus') {
        // A syntactically valid media id this homeserver has never stored: the download 404s (AC-V5-4).
        mxc = `mxc://${SERVER_NAME}/qaMissing${Date.now().toString(36)}`;
      } else if (opts.url) {
        mxc = opts.url;
      } else {
        mxc = await api.upload(bytes, mimetype, name);
      }
      if (opts.url) size = bytes.length; // the event still claims a plausible size

      const content: Record<string, unknown> = {
        msgtype: 'm.audio',
        body: 'Voice message',
        url: mxc,
        info: { duration: durationMs, mimetype, size },
        'org.matrix.msc1767.text': 'Voice message',
        'org.matrix.msc1767.file': { url: mxc, name, mimetype, size },
        ...(opts.msc1767 === false ? {} : { 'org.matrix.msc1767.audio': { duration: durationMs, waveform } }),
        ...(opts.voice === false ? {} : { 'org.matrix.msc3245.voice': {} }),
        ...(opts.extra ?? {}),
      };

      const eventId = await api.sendEvent(roomId, 'm.room.message', content);
      return { eventId, mxc, mimetype, durationMs, waveform, size, content };
    },

    async getMedia(mxc) {
      const path = mxc.replace(/^mxc:\/\//, '');
      const res = await fetch(`${HS_URL}/_matrix/media/v3/download/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const magicHex = [...bytes.subarray(0, 8)]
        .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
      return {
        status: res.status,
        bytes,
        contentType: res.headers.get('content-type') ?? '',
        magicHex,
        container: detectContainer(bytes),
      };
    },

    // ------------------------------------------------------------ threads (Phase 3)

    async sendThreadReply(roomId, rootId, body, opts = {}) {
      let latest = opts.latest;
      if (!latest) {
        const existing = await api.getRelations(roomId, rootId, { limit: 1, maxPages: 1 });
        latest = existing.replyIds[0] ?? rootId; // `dir=b` -> [0] is the newest reply
      }
      return api.sendEvent(roomId, 'm.room.message', {
        msgtype: 'm.text',
        body,
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: rootId,
          is_falling_back: true,
          'm.in_reply_to': { event_id: latest },
        },
        ...(opts.extra ?? {}),
      });
    },

    async getThreads(roomId, opts = {}) {
      const { include = 'all', limit = 50, maxPages = 3 } = opts;
      const chunk: MatrixEventJson[] = [];
      let from: string | undefined;
      let nextBatch: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const res = await request<{ chunk?: MatrixEventJson[]; next_batch?: string }>(
          'GET',
          `${V1}/rooms/${room(roomId)}/threads`,
          { token, query: { include, limit, from } },
        );
        chunk.push(...(res.chunk ?? []));
        nextBatch = res.next_batch;
        if (!res.next_batch || (res.chunk ?? []).length === 0) {
          nextBatch = undefined;
          break;
        }
        from = res.next_batch;
      }
      return { chunk, rootIds: chunk.map((e) => e.event_id), nextBatch };
    },

    async getRelations(roomId, rootId, opts = {}) {
      const { limit = 50, maxPages = 5, oldestFirst = false } = opts;
      const chunk: MatrixEventJson[] = [];
      let from: string | undefined;
      let nextBatch: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const res = await request<{ chunk?: MatrixEventJson[]; next_batch?: string }>(
          'GET',
          `${V1}/rooms/${room(roomId)}/relations/${encodeURIComponent(rootId)}/m.thread`,
          { token, query: { dir: 'b', limit, from } },
        );
        chunk.push(...(res.chunk ?? []));
        nextBatch = res.next_batch;
        if (!res.next_batch || (res.chunk ?? []).length === 0) {
          nextBatch = undefined;
          break;
        }
        from = res.next_batch;
      }
      const ordered = oldestFirst ? [...chunk].reverse() : chunk;
      return { chunk: ordered, replyIds: ordered.map((e) => e.event_id), nextBatch };
    },

    async getThreadSummary(roomId, rootId) {
      const read = (event: MatrixEventJson | undefined): ServerThreadSummary | null => {
        const relations = event?.unsigned?.['m.relations'] as
          | Record<string, ServerThreadSummary>
          | undefined;
        const summary = relations?.['m.thread'];
        return summary && typeof summary.count === 'number' ? summary : null;
      };
      // `/event` is the cheap path; `/messages` is the fallback because Synapse does not bundle
      // relations on every path for every event age (the Advisor's probe reads both).
      const direct = read(await api.getEvent(roomId, rootId).catch(() => undefined));
      if (direct) return direct;
      const chunk = await api.messagesDeep(roomId, 3);
      return read(chunk.find((e) => e.event_id === rootId));
    },

    threadSummaryOf(roomId, rootId) {
      return api.getThreadSummary(roomId, rootId);
    },

    getFilter(filterId) {
      return request<Record<string, unknown> | undefined>(
        'GET',
        `${V3}/user/${encodeURIComponent(userId)}/filter/${encodeURIComponent(filterId)}`,
        { token, allow404: true },
      );
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
