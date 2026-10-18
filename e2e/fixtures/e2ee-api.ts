/**
 * Phase 5 (QA-24) server-side checks for end-to-end encryption, independent of the app and its SDK.
 *
 *   const u = await freshUser();                          // throwaway account (AC-E4-1 `setup`)
 *   const ev = await rawEvent(token, roomId, eventId);    // what the server stores
 *   expectEncryptedOnWire(ev);                             // m.room.encrypted, megolm, no plaintext
 *   const bytes = await rawMediaBytes(token, file.url);   // ciphertext on the media repo
 *   expect(sha256b64(bytes)).toBe(file.hashes.sha256);
 *
 * Plain `fetch` on purpose (same rule as matrix-api.ts): a bug in the app's crypto wiring must not be able to
 * make one of these pass. Fresh users get the seed password so `scripts/send-encrypted-sample.mjs --as <name>`
 * can log them in too.
 */
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { noteServerUse } from './run-log.ts';
import { HS_URL, PASSWORD, SERVER_NAME } from './seed.ts';

const V3 = `${HS_URL}/_matrix/client/v3`;
const MEGOLM = 'm.megolm.v1.aes-sha2';
let txn = 0;

export interface Credentials {
  username: string;
  userId: string;
  password: string;
  token: string;
  deviceId: string;
}

export interface WireEvent {
  event_id: string;
  type: string;
  sender: string;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

async function call<T>(method: string, path: string, token?: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: T }> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(path.startsWith('http') ? path : `${V3}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as T & { retry_after_ms?: number };
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Math.min((json.retry_after_ms ?? 500) + 50, 5000)));
      continue;
    }
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { status: res.status, json };
  }
  throw new Error(`${method} ${path}: still rate-limited`);
}

/** Registers a throwaway account (open registration on the local Synapse) with the seed password. */
export async function freshUser(prefix = 'qae2ee'): Promise<Credentials> {
  const username = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const body = { username, password: PASSWORD, initial_device_display_name: 'matrix-poc e2e (api)' };
  const first = await call<{ session?: string; access_token?: string; user_id?: string; device_id?: string }>('POST', '/register', undefined, body, [401]);
  const done =
    first.status === 401
      ? (await call<{ access_token: string; user_id: string; device_id: string }>('POST', '/register', undefined, { ...body, auth: { type: 'm.login.dummy', session: first.json.session } })).json
      : (first.json as { access_token: string; user_id: string; device_id: string });
  return { username, userId: done.user_id, password: PASSWORD, token: done.access_token, deviceId: done.device_id };
}

/** Password login as any user (seeded or fresh): a new device every call. */
export async function apiLogin(username: string, password = PASSWORD, deviceName = 'matrix-poc e2e (api)'): Promise<Credentials> {
  noteServerUse();
  const { json } = await call<{ access_token: string; user_id: string; device_id: string }>('POST', '/login', undefined, {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: username },
    password,
    initial_device_display_name: deviceName,
  });
  return { username, userId: json.user_id, password, token: json.access_token, deviceId: json.device_id };
}

/** Logs an API device out (keeps `GET /devices` from growing across runs). */
export async function apiLogout(token: string): Promise<void> {
  await call('POST', '/logout', token, {}, [401]).catch(() => undefined);
}

/** The event exactly as the server stores it (no decryption). */
export async function rawEvent(token: string, roomId: string, eventId: string): Promise<WireEvent> {
  return (await call<WireEvent>('GET', `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, token)).json;
}

/**
 * AC-E2-1 / AC-E3-* / AC-E6-*: the event is `m.room.encrypted` with Megolm and carries no plaintext field.
 * `relation` = the `rel_type` the cleartext `m.relates_to` must carry (AC-E2-5), if any.
 */
export function expectEncryptedOnWire(event: WireEvent, opts: { relation?: string; label?: string } = {}): void {
  const label = opts.label ?? event.event_id;
  expect(event.type, `${label}: type on the wire`).toBe('m.room.encrypted');
  const c = event.content;
  expect(c.algorithm, `${label}: algorithm`).toBe(MEGOLM);
  expect(typeof c.ciphertext, `${label}: ciphertext`).toBe('string');
  expect(typeof c.session_id, `${label}: session_id`).toBe('string');
  for (const leak of ['body', 'msgtype', 'url', 'file', 'formatted_body', 'info', 'key']) {
    expect(c[leak], `${label}: "${leak}" must not be visible on the wire`).toBeUndefined();
  }
  if (opts.relation) {
    const rel = c['m.relates_to'] as { rel_type?: string } | undefined;
    expect(rel?.rel_type, `${label}: cleartext m.relates_to.rel_type`).toBe(opts.relation);
  }
}

/** Raw bytes of an mxc on the media repo (authenticated v1 first, legacy v3 as fallback). */
export async function rawMediaBytes(token: string, mxc: string): Promise<Uint8Array> {
  const path = mxc.replace(/^mxc:\/\//, '');
  for (const url of [`${HS_URL}/_matrix/client/v1/media/download/${path}`, `${HS_URL}/_matrix/media/v3/download/${path}`]) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error(`media ${mxc} not downloadable`);
}

/** Unpadded base64 SHA-256, the `hashes.sha256` encoding of the attachment spec. */
export function sha256b64(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

/** A state event's content, or undefined when the room has none. */
export async function stateContent(token: string, roomId: string, type: string, stateKey = ''): Promise<Record<string, unknown> | undefined> {
  const r = await call<Record<string, unknown>>('GET', `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`, token, undefined, [404]);
  return r.status === 404 ? undefined : r.json;
}

/** AC-E6-6: turn a room encrypted through the API. */
export async function setRoomEncryption(token: string, roomId: string): Promise<void> {
  await call('PUT', `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`, token, { algorithm: MEGOLM });
}

export async function sendStateEvent(token: string, roomId: string, type: string, stateKey: string, content: unknown): Promise<void> {
  await call('PUT', `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`, token, content);
}

/** Sends a raw event (plaintext, the API cannot encrypt): used for the forged-hash image of AC-E3-5. */
export async function sendRaw(token: string, roomId: string, type: string, content: unknown): Promise<string> {
  txn += 1;
  const r = await call<{ event_id: string }>('PUT', `/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/qa-e2ee-${Date.now()}-${txn}`, token, content);
  return r.json.event_id;
}

export async function redact(token: string, roomId: string, eventId: string): Promise<void> {
  txn += 1;
  await call('PUT', `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/qa-e2ee-r-${Date.now()}-${txn}`, token, {});
}

export interface CreateRoomOptions {
  name: string;
  encrypted?: boolean;
  invite?: string[];
  /** Space to list the room under (`m.space.parent` here + `m.space.child` in the space; the caller must be able to write the space). */
  spaceId?: string;
  powerUsers?: Record<string, number>;
  preset?: 'private_chat' | 'public_chat';
  /** Create a space (`creation_content.type = m.space`). */
  space?: boolean;
}

export async function createRoom(token: string, opts: CreateRoomOptions): Promise<string> {
  const initial_state: unknown[] = [];
  if (opts.encrypted) initial_state.push({ type: 'm.room.encryption', state_key: '', content: { algorithm: MEGOLM } });
  if (opts.spaceId) initial_state.push({ type: 'm.space.parent', state_key: opts.spaceId, content: { via: [SERVER_NAME], canonical: true } });
  const { json } = await call<{ room_id: string }>('POST', '/createRoom', token, {
    name: opts.name,
    preset: opts.preset ?? 'private_chat',
    invite: opts.invite ?? [],
    initial_state,
    ...(opts.space ? { creation_content: { type: 'm.space' } } : {}),
    ...(opts.powerUsers ? { power_level_content_override: { users: opts.powerUsers } } : {}),
  });
  if (opts.spaceId) await sendStateEvent(token, opts.spaceId, 'm.space.child', json.room_id, { via: [SERVER_NAME] });
  return json.room_id;
}

export async function joinRoom(token: string, roomId: string): Promise<void> {
  await call('POST', `/join/${encodeURIComponent(roomId)}`, token, {});
}

export interface DeviceRow {
  device_id: string;
  display_name?: string;
}

export async function devicesOf(token: string): Promise<DeviceRow[]> {
  return (await call<{ devices: DeviceRow[] }>('GET', '/devices', token)).json.devices;
}

/** `DELETE /devices/{id}` with the password UIA stage (AC-E1-4: the app's token dies under it). */
export async function deleteDevice(token: string, username: string, deviceId: string, password = PASSWORD): Promise<void> {
  const path = `/devices/${encodeURIComponent(deviceId)}`;
  const first = await call<{ session?: string }>('DELETE', path, token, {}, [401]);
  if (first.status !== 401) return;
  await call('DELETE', path, token, {
    auth: { type: 'm.login.password', identifier: { type: 'm.id.user', user: username }, password, session: first.json.session },
  });
}

/** `GET /room_keys/version`: the current key backup, or null (AC-E4-2, AC-E5-6). */
export async function keyBackup(token: string): Promise<{ version: string; count: number; etag: string; algorithm: string } | null> {
  const r = await call<{ version: string; count: number; etag: string; algorithm: string }>('GET', '/room_keys/version', token, undefined, [404]);
  return r.status === 404 ? null : r.json;
}

/** Does the account have published cross-signing keys (master key in `/keys/query`)? */
export async function hasCrossSigning(token: string, userId: string): Promise<boolean> {
  const { json } = await call<{ master_keys?: Record<string, unknown> }>('POST', '/keys/query', token, { device_keys: { [userId]: [] } });
  return !!json.master_keys?.[userId];
}

/** The account's default secret storage key id, or null (AC-E5-5: must never change once set). */
export async function defaultSecretStorageKey(token: string, userId: string): Promise<string | null> {
  const r = await call<{ key?: string }>('GET', `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`, token, undefined, [404]);
  return r.status === 404 ? null : (r.json.key ?? null);
}

/** Global account data of `type` (e.g. `m.megolm_backup.v1`: `{ encrypted: { <keyId>: ... } }`), or null. */
export async function accountData<T = Record<string, unknown>>(token: string, userId: string, type: string): Promise<T | null> {
  const r = await call<T>('GET', `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`, token, undefined, [404]);
  return r.status === 404 ? null : r.json;
}

/** The device's identity keys as the server publishes them (AC-E1-1: keys uploaded). */
export async function publishedDeviceKeys(token: string, userId: string, deviceId: string): Promise<Record<string, string> | null> {
  const { json } = await call<{ device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>> }>('POST', '/keys/query', token, { device_keys: { [userId]: [deviceId] } });
  return json.device_keys?.[userId]?.[deviceId]?.keys ?? null;
}
