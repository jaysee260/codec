#!/usr/bin/env node
/**
 * Phase 7: local stand-in for Element's lk-jwt-service (the LiveKit auth service of MatrixRTC, MSC4195 standalone
 * mode). The homelab runs the real lk-jwt-service 0.9.0; the dev stack and the e2e pool run this, one per Synapse,
 * because the real one (Rust) resolves the homeserver by *federation discovery of the server name* (`https://localhost`,
 * SRV, well-known), which can never reach a plain-HTTP Synapse on `localhost:8008+i`. Same routes, same request and
 * response bodies, same LiveKit room name / identity derivation (`src/lib/rtc/livekit-token.ts`), same error shapes:
 *
 *   POST /sfu/get      { room, openid_token, device_id }            -> { url, jwt }   (legacy; what Codec on js-sdk 43 uses)
 *   POST /get_token    { room_id, slot_id, openid_token, member }   -> { url, jwt }   (MSC4195, pre-0.8 body shape; Codec never calls it)
 *   GET  /healthz                                                   -> 200 "ok"
 *   OPTIONS *          CORS preflight (`Access-Control-Allow-Origin: *`, like the real service behind NPM)
 *
 * The OpenID token is verified the way lk-jwt-service does it: `GET <homeserver>/_matrix/federation/v1/openid/userinfo
 * ?access_token=...` must answer `{ sub }`, and `sub`'s server name must equal `openid_token.matrix_server_name`. A user
 * whose server is in LIVEKIT_FULL_ACCESS_HOMESERVERS gets `roomCreate` (the real service creates the room via the API
 * instead; LiveKit's default `auto_create: true` does the same here). Everyone else can only join an existing room.
 *
 * Environment (same names as lk-jwt-service where they exist):
 *   LIVEKIT_URL                      ws(s) URL of the SFU handed back in `url`         (required)
 *   LIVEKIT_KEY / LIVEKIT_SECRET     the SFU API key pair                              (required)
 *   LIVEKIT_FULL_ACCESS_HOMESERVERS  comma-separated server names, `*` for all         (default: localhost)
 *   LIVEKIT_JWT_BIND                 host:port to listen on                            (default: 127.0.0.1:7980)
 *   LIVEKIT_HOMESERVER_URL           base URL of the Synapse to verify tokens against  (required; this is the local-only knob)
 *
 *   node scripts/lib/lk-jwt.mjs      runs it (scripts/rtc.mjs and scripts/hs-pool.mjs spawn it detached)
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const tokenLib = await import('../../src/lib/rtc/livekit-token.ts');
const { LEGACY_SLOT_ID, hashedLivekitIdentity, legacyLivekitIdentity, livekitRoomAliasFor, mintLivekitToken, serverNameOfUserId, validateLegacySfuRequest } =
  tokenLib;

export function readConfig(env = process.env) {
  const need = (name) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const bind = env.LIVEKIT_JWT_BIND ?? '127.0.0.1:7980';
  const [host, portText] = bind.startsWith(':') ? ['127.0.0.1', bind.slice(1)] : bind.split(':');
  return {
    livekitUrl: need('LIVEKIT_URL'),
    apiKey: need('LIVEKIT_KEY'),
    apiSecret: need('LIVEKIT_SECRET'),
    homeserverUrl: need('LIVEKIT_HOMESERVER_URL').replace(/\/+$/, ''),
    fullAccess: (env.LIVEKIT_FULL_ACCESS_HOMESERVERS ?? 'localhost').split(',').map((s) => s.trim()).filter(Boolean),
    host: host || '127.0.0.1',
    port: Number(portText),
  };
}

class HttpError extends Error {
  constructor(status, errcode, message) {
    super(message);
    this.status = status;
    this.errcode = errcode;
  }
}

/** lk-jwt-service `verify_openid_token`: the federation userinfo endpoint of the token's server must know it. */
export async function verifyOpenIdToken(homeserverUrl, openIdToken, { fetchImpl = fetch } = {}) {
  const url = `${homeserverUrl}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(openIdToken.access_token)}`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new HttpError(500, 'M_UNKNOWN', `Could not reach the homeserver to verify the OpenID token: ${e.message}`);
  }
  if (res.status === 401) throw new HttpError(401, 'M_LOOKUP_FAILED', 'The OpenID token was rejected by the homeserver');
  if (!res.ok) throw new HttpError(500, 'M_UNKNOWN', `The homeserver answered ${res.status} to the OpenID userinfo request`);
  const body = await res.json().catch(() => ({}));
  const sub = typeof body.sub === 'string' ? body.sub : '';
  const server = serverNameOfUserId(sub);
  if (!server) throw new HttpError(500, 'M_UNKNOWN', 'The homeserver returned an invalid user id');
  if (server !== openIdToken.matrix_server_name) {
    throw new HttpError(401, 'M_LOOKUP_FAILED', `The OpenID token belongs to ${server}, not ${openIdToken.matrix_server_name}`);
  }
  return sub;
}

export function isFullAccess(fullAccess, serverName) {
  return fullAccess.includes('*') || fullAccess.includes(serverName);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'M_NOT_JSON', 'The request body is not valid JSON');
  }
}

/** Build the response for `/sfu/get` from a validated body. Exported for unit tests. */
export async function legacySfuGet(cfg, body, deps = {}) {
  const problem = validateLegacySfuRequest(body);
  if (problem) throw new HttpError(400, 'M_BAD_JSON', problem);
  const userId = await verifyOpenIdToken(cfg.homeserverUrl, body.openid_token, deps);
  const full = isFullAccess(cfg.fullAccess, body.openid_token.matrix_server_name);
  const identity = legacyLivekitIdentity(userId, body.device_id);
  const room = await livekitRoomAliasFor(body.room, LEGACY_SLOT_ID);
  const jwt = await mintLivekitToken({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, identity, room, roomCreate: full });
  return { url: cfg.livekitUrl, jwt, identity, room, userId, full };
}

/** MSC4195 `/get_token` (standalone): hashed identity, `room_id` + `slot_id`. */
export async function msc4195GetToken(cfg, body, deps = {}) {
  const t = body?.openid_token;
  if (!t || typeof t !== 'object' || !t.access_token || !t.matrix_server_name) {
    throw new HttpError(400, 'M_BAD_JSON', 'The request body `openid_token` is missing `access_token` or `matrix_server_name`');
  }
  if (typeof body.room_id !== 'string' || !body.room_id) throw new HttpError(400, 'M_BAD_JSON', 'The request body is missing `room_id`');
  if (typeof body.slot_id !== 'string' || !body.slot_id) throw new HttpError(400, 'M_BAD_JSON', 'The request body is missing `slot_id`');
  const member = body.member;
  if (!member || typeof member.id !== 'string' || !member.id) throw new HttpError(400, 'M_BAD_JSON', 'The request body is missing `member.id`');
  const userId = await verifyOpenIdToken(cfg.homeserverUrl, t, deps);
  const full = isFullAccess(cfg.fullAccess, t.matrix_server_name);
  const identity = await hashedLivekitIdentity(userId, String(member.claimed_device_id ?? ''), member.id);
  const room = await livekitRoomAliasFor(body.room_id, body.slot_id);
  const jwt = await mintLivekitToken({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, identity, room, roomCreate: full });
  return { url: cfg.livekitUrl, jwt, identity, room, userId, full };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function send(res, status, body, extra = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...extra });
  res.end(text);
}

export function createJwtServer(cfg, { log = () => {} } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok');
      if (req.method === 'POST' && url.pathname === '/sfu/get') {
        const out = await legacySfuGet(cfg, await readJson(req));
        log(`sfu/get ${out.userId} (${out.full ? 'full' : 'restricted'}) -> room ${out.room} identity ${out.identity}`);
        return send(res, 200, { url: out.url, jwt: out.jwt });
      }
      if (req.method === 'POST' && url.pathname === '/get_token') {
        const out = await msc4195GetToken(cfg, await readJson(req));
        log(`get_token ${out.userId} (${out.full ? 'full' : 'restricted'}) -> room ${out.room} identity ${out.identity}`);
        return send(res, 200, { url: out.url, jwt: out.jwt });
      }
      return send(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      log(`${req.method} ${url.pathname} -> ${status} ${e.message}`);
      return send(res, status, { errcode: e.errcode ?? 'M_UNKNOWN', error: e.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = readConfig();
  const server = createJwtServer(cfg, { log: (m) => console.log(`[lk-jwt] ${new Date().toISOString()} ${m}`) });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[lk-jwt] listening on http://${cfg.host}:${cfg.port} (homeserver ${cfg.homeserverUrl}, sfu ${cfg.livekitUrl}, full access: ${cfg.fullAccess.join(', ')})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
