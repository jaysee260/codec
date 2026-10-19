#!/usr/bin/env node
/**
 * Phase 7 (PRIN-27): proves the local call stack end to end without a browser. `npm run rtc:probe`.
 *
 *  1. well-known   GET <HS_URL>/.well-known/matrix/client carries `org.matrix.msc4143.rtc_foci` with a livekit focus
 *  2. jwt health   GET <livekit_service_url>/healthz answers 200 with CORS
 *  3. openid       alice logs in (API), `POST /_matrix/client/v3/user/{id}/openid/request_token`
 *  4. /sfu/get     the legacy route answers `{ url, jwt }`; the JWT verifies with the dev secret, `sub` is
 *                  `@alice:localhost:<DEVICE>`, `video.room` is the room alias hash of `[roomId, "m.call#ROOM"]`
 *  5. bad token    a forged OpenID token is refused with 401 M_LOOKUP_FAILED
 *  6. sfu          the LiveKit HTTP root answers (the SFU is up on the url `/sfu/get` handed back)
 *  7. membership   (unless --no-join) a Node js-sdk crypto client joins the room's MatrixRTC session with the same
 *                  options as the browser (`joinRTCSession`, delayed leave), the `org.matrix.msc3401.call.member`
 *                  state event appears on the wire with `membershipID user:device`, then leaves and the state is cleared
 *
 * Options: --room '#vault:localhost' | '!id' (default: the alice/dave DM), --as alice, --no-join, --json.
 * Environment: HS_URL (default http://localhost:8008), PASSWORD. Exits 1 on the first failed step.
 */
import { api, HS, login, logout, resolveRoom } from './lib/gif-api.mjs';
import { startCryptoClient } from './lib/e2ee-api.mjs';
import { LIVEKIT_API_SECRET } from './lib/rtc-stack.mjs';
import { decodeJwtClaims, livekitRoomAliasFor, verifyLivekitToken } from '../src/lib/rtc/livekit-token.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const USER = opt('--as', 'alice');
const ROOM = opt('--room', null);
const JOIN = !args.includes('--no-join');
const JSON_OUT = args.includes('--json');

const report = { hs: HS, steps: [] };
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  if (!JSON_OUT) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) {
    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

async function findDm(session) {
  const joined = await api('GET', '/_matrix/client/v3/joined_rooms', { token: session.token });
  const dm = await api('GET', `/_matrix/client/v3/user/${encodeURIComponent(session.userId)}/account_data/m.direct`, { token: session.token }).catch(() => ({}));
  const dave = Object.entries(dm).find(([u]) => u.startsWith('@dave:'));
  const id = dave?.[1]?.find((r) => joined.joined_rooms.includes(r));
  if (!id) throw new Error('no DM with dave in m.direct; pass --room');
  return id;
}

// 1. well-known
const wk = await fetch(`${HS}/.well-known/matrix/client`).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const focus = wk.json?.['org.matrix.msc4143.rtc_foci']?.find((f) => f?.type === 'livekit' && typeof f.livekit_service_url === 'string');
step('well-known rtc_foci', wk.status === 200 && !!focus, focus ?? wk);
const JWT = focus.livekit_service_url.replace(/\/+$/, '');

// 2. jwt health
const health = await fetch(`${JWT}/healthz`).then((r) => ({ status: r.status, cors: r.headers.get('access-control-allow-origin') })).catch((e) => ({ error: e.message }));
step('lk-jwt /healthz', health.status === 200 && health.cors === '*', health);

// 3. login + openid
const session = await login(USER, 'rtc-probe');
const deviceId = (await api('GET', '/_matrix/client/v3/account/whoami', { token: session.token })).device_id;
const roomId = ROOM ? await resolveRoom(session, ROOM) : await findDm(session);
const openid = await api('POST', `/_matrix/client/v3/user/${encodeURIComponent(session.userId)}/openid/request_token`, { token: session.token, body: {} });
step('openid token', typeof openid.access_token === 'string' && openid.matrix_server_name === session.userId.split(':').slice(1).join(':'), { matrix_server_name: openid.matrix_server_name, expires_in: openid.expires_in });

// 4. /sfu/get
const sfu = await fetch(`${JWT}/sfu/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: roomId, openid_token: openid, device_id: deviceId }) });
const sfuJson = await sfu.json().catch(() => null);
step('/sfu/get answers', sfu.status === 200 && typeof sfuJson?.url === 'string' && typeof sfuJson?.jwt === 'string', { status: sfu.status, url: sfuJson?.url, error: sfuJson?.error });
const claims = decodeJwtClaims(sfuJson.jwt);
const alias = await livekitRoomAliasFor(roomId);
step('jwt claims', claims.sub === `${session.userId}:${deviceId}` && claims.video?.room === alias && claims.video?.roomJoin === true && claims.video?.canPublish === true, { sub: claims.sub, room: claims.video?.room, roomCreate: claims.video?.roomCreate, exp: claims.exp });
step('jwt signature (dev secret)', await verifyLivekitToken(sfuJson.jwt, LIVEKIT_API_SECRET), 'HS256 with scripts/lib/rtc-stack.mjs LIVEKIT_API_SECRET');

// 5. forged openid
const bad = await fetch(`${JWT}/sfu/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: roomId, openid_token: { ...openid, access_token: 'forged' }, device_id: deviceId }) });
const badJson = await bad.json().catch(() => null);
step('forged openid refused', bad.status === 401 && badJson?.errcode === 'M_LOOKUP_FAILED', { status: bad.status, errcode: badJson?.errcode });

// 6. SFU reachable
const sfuHttp = sfuJson.url.replace(/^ws/, 'http');
const root = await fetch(sfuHttp).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 40) })).catch((e) => ({ error: e.message }));
step('livekit answers', root.status === 200, { url: sfuJson.url, ...root });

// 7. MatrixRTC membership on the wire
if (JOIN) {
  const { MatrixRTCSessionEvent } = await import('matrix-js-sdk/lib/matrixrtc/index.js');
  const crypto = await startCryptoClient(USER, 'rtc-probe-join');
  const { client } = crypto;
  try {
    const room = client.getRoom(roomId);
    if (!room) throw new Error(`room ${roomId} not in the sync yet`);
    const rtc = client.matrixRTC.getRoomSession(room);
    const own = { userId: client.getUserId(), deviceId: client.getDeviceId(), memberId: `${client.getUserId()}:${client.getDeviceId()}` };
    const joined = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('own membership not seen within 20 s')), 20_000);
      rtc.on(MatrixRTCSessionEvent.MembershipsChanged, () => {
        if (rtc.memberships.some((m) => m.sender === own.userId && m.deviceId === own.deviceId)) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    rtc.joinRTCSession(own, [focus], undefined, { manageMediaKeys: false, callIntent: 'audio', delayedLeaveEventDelayMs: 8000 });
    await joined;
    const stateKey = `_${own.userId}_${own.deviceId}_m.call`; // js-sdk 43 MembershipManager.makeMembershipStateKey (slot m.call#ROOM)
    const member = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(stateKey)}`, { token: session.token }).catch(() => null);
    step('org.matrix.msc3401.call.member on the wire', member?.membershipID === own.memberId && member?.application === 'm.call' && member?.foci_preferred?.[0]?.type === 'livekit', { stateKey, membershipID: member?.membershipID, foci_preferred: member?.foci_preferred, expires: member?.expires });
    await rtc.leaveRoomSession(5000);
    const after = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(stateKey)}`, { token: session.token }).catch(() => null);
    step('membership cleared on leave', after !== null && Object.keys(after).length === 0, after);
  } finally {
    await crypto.stop().catch(() => undefined);
  }
}

await logout(session);
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else console.log(`\nall ${report.steps.length} steps ok (${HS} -> ${JWT} -> ${sfuJson.url})`);
process.exit(0); // the SDK's MatrixRTC timers would keep the process alive after stopClient()
