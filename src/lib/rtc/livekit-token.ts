/**
 * Phase 7 (voice calls): pure helpers for the LiveKit side of MatrixRTC. No DOM, no Matrix client; Node-loadable
 * (the local auth service `scripts/lib/lk-jwt.mjs` imports this file, type-stripped, like the gif scripts do).
 *
 * The contract mirrors Element's lk-jwt-service 0.8.0 (the homelab runs the real thing; the test pool runs the Node
 * port in `scripts/lib/lk-jwt.mjs`), so a token minted here is accepted by the same LiveKit server config:
 *
 *   - legacy `/sfu/get` (what matrix-js-sdk 43's state-event memberships need): LiveKit identity = `${userId}:${deviceId}`,
 *     which is exactly `CallMembership.rtcBackendIdentity` for `m.call.member` state events, so the media keys the SDK
 *     emits (`EncryptionKeyChanged(..., rtcBackendIdentity)`) match the SFU participant identity without a lookup;
 *   - MSC4195 `/get_token`: identity = unpadded-base64 SHA-256 of the JSON array `[userId, claimedDeviceId, memberId]`
 *     (what js-sdk 44's sticky `m.rtc.member` memberships use; kept for parity, Codec does not call it yet);
 *   - the LiveKit room name is unpadded-base64 SHA-256 of `[roomId, slotId]` in both flows (`m.call#ROOM` for the legacy one).
 */

export const LEGACY_SLOT_ID = 'm.call#ROOM';

/** Request body of the legacy `POST /sfu/get` (lk-jwt-service `LegacySfuRequest`). */
export interface LegacySfuRequest {
  room: string;
  openid_token: OpenIdToken;
  device_id: string;
}

/** `GET /_matrix/client/v3/user/{userId}/openid/request_token` response, as the SDK's `getOpenIdToken()` returns it. */
export interface OpenIdToken {
  access_token: string;
  token_type: string;
  matrix_server_name: string;
  expires_in: number;
}

/** `POST /sfu/get` and `POST /get_token` both answer with this. */
export interface SfuResponse {
  url: string;
  jwt: string;
}

/** LiveKit's `VideoGrant` claims (the subset lk-jwt-service sets). */
export interface VideoGrant {
  room: string;
  roomJoin: boolean;
  roomCreate: boolean;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData?: boolean;
}

export interface LivekitClaims {
  iss: string;
  sub: string;
  nbf: number;
  exp: number;
  video: VideoGrant;
}

const te = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256UnpaddedBase64(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}

/** lk-jwt-service's `marshal_strings`: the JSON encoding of the string array, no spaces (serde_json default). */
function marshalStrings(parts: string[]): Uint8Array {
  return te.encode(JSON.stringify(parts));
}

/** The LiveKit room a Matrix room + slot map to (`livekit_room_alias_for`). */
export async function livekitRoomAliasFor(roomId: string, slotId: string = LEGACY_SLOT_ID): Promise<string> {
  return sha256UnpaddedBase64(marshalStrings([roomId, slotId]));
}

/** The LiveKit participant identity of a legacy (state-event) membership: `${userId}:${deviceId}`. */
export function legacyLivekitIdentity(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/** The LiveKit participant identity of an MSC4195 `/get_token` request (`legacy_livekit_identity_for` in lk-jwt-service). */
export async function hashedLivekitIdentity(userId: string, claimedDeviceId: string, memberId: string): Promise<string> {
  return sha256UnpaddedBase64(marshalStrings([userId, claimedDeviceId, memberId]));
}

/** `@alice:localhost` -> `localhost`; null when the id is not a Matrix user id. */
export function serverNameOfUserId(userId: string): string | null {
  if (!userId.startsWith('@')) return null;
  const idx = userId.indexOf(':');
  if (idx <= 1 || idx === userId.length - 1) return null;
  return userId.slice(idx + 1);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Mint a LiveKit access token (HS256 JWT), the claims lk-jwt-service's `get_join_token` sets: `roomJoin`, `canSubscribe`,
 * `canPublish` always; `roomCreate` for full-access users (lk-jwt-service creates the room through the API instead,
 * the local stack lets LiveKit auto-create). `ttlSeconds` defaults to lk-jwt-service's one hour.
 */
export async function mintLivekitToken(
  opts: { apiKey: string; apiSecret: string; identity: string; room: string; canPublish?: boolean; roomCreate?: boolean; ttlSeconds?: number; now?: number },
): Promise<string> {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: LivekitClaims = {
    iss: opts.apiKey,
    sub: opts.identity,
    nbf: now,
    exp: now + (opts.ttlSeconds ?? 3600),
    video: {
      room: opts.room,
      roomJoin: true,
      roomCreate: opts.roomCreate ?? false,
      canPublish: opts.canPublish ?? true,
      canSubscribe: true,
      canPublishData: true,
    },
  };
  const header = base64UrlEncode(te.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(te.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(opts.apiSecret), te.encode(`${header}.${payload}`) as BufferSource));
  return `${header}.${payload}.${base64UrlEncode(signature)}`;
}

/** Decode a JWT's claims without verifying (for the probe script and tests). */
export function decodeJwtClaims(jwt: string): LivekitClaims {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!))) as LivekitClaims;
}

/** Verify an HS256 JWT's signature (tests and the probe). */
export async function verifyLivekitToken(jwt: string, apiSecret: string): Promise<boolean> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(apiSecret), base64UrlDecode(parts[2]!) as BufferSource, te.encode(`${parts[0]}.${parts[1]}`) as BufferSource);
}

/** The request Codec sends to `<livekit_service_url>/sfu/get`. */
export function buildLegacySfuRequest(roomId: string, openIdToken: OpenIdToken, deviceId: string): LegacySfuRequest {
  return { room: roomId, openid_token: openIdToken, device_id: deviceId };
}

/**
 * Validate a `/sfu/get` body the way lk-jwt-service does (`M_BAD_JSON` with a message when a field is missing).
 * Returns the problem, or null when the body is usable.
 */
export function validateLegacySfuRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'The request body is not a JSON object';
  const b = body as Partial<LegacySfuRequest>;
  if (typeof b.room !== 'string' || !b.room) return 'The request body is missing `room`';
  if (typeof b.device_id !== 'string' || !b.device_id) return 'The request body is missing `device_id`';
  const t = b.openid_token;
  if (!t || typeof t !== 'object' || !t.access_token || !t.matrix_server_name) {
    return 'The request body `openid_token` is missing `access_token` or `matrix_server_name`';
  }
  return null;
}
