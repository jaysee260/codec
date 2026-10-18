/**
 * Shared helpers for the Phase 5 scripts (`send-encrypted-sample.mjs`, `verify-e2ee.mjs`): a Node matrix-js-sdk
 * client with the Rust crypto engine (in-memory store; the WASM loads through the package's Node entry), raw
 * client-server API calls, and the client's own `attachment-crypto.ts` (type-stripped import) so the image is encrypted
 * exactly like the browser does it. Nothing here touches Playwright.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createClient, ClientEvent, SyncState } from 'matrix-js-sdk';
import { api, HS, PASSWORD, login as rawLogin, logout as rawLogout, resolveRoom } from './gif-api.mjs';

export { api, HS, PASSWORD, resolveRoom };

/** Only warnings and errors from the SDK (its default logger prints every sync and crypto step). */
const quiet = () => {};
export const quietLogger = { trace: quiet, debug: quiet, info: quiet, warn: console.warn, error: console.error, getChild: () => quietLogger };

/** Password login + a started, crypto-enabled SDK client. `stop()` logs the device out (no stale devices). */
export async function startCryptoClient(user, deviceName = 'e2ee-sample') {
  const raw = await rawLogin(user, deviceName);
  const client = createClient({
    baseUrl: HS,
    userId: raw.userId,
    accessToken: raw.token,
    deviceId: raw.deviceId,
    timelineSupport: true,
    logger: quietLogger,
  });
  await client.initRustCrypto({ useIndexedDB: false });
  await client.startClient({ initialSyncLimit: 10, lazyLoadMembers: true, threadSupport: true });
  await new Promise((resolve, reject) => {
    const onSync = (state, _prev, data) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        client.off(ClientEvent.Sync, onSync);
        resolve();
      } else if (state === SyncState.Error) {
        client.off(ClientEvent.Sync, onSync);
        reject(data?.error ?? new Error('sync error'));
      }
    };
    client.on(ClientEvent.Sync, onSync);
  });
  return {
    client,
    session: raw,
    async stop() {
      client.stopClient();
      await rawLogout(raw);
    },
  };
}

/** Patch `login` from gif-api to also keep the device id (the SDK needs it for crypto). */
export async function loginWithDevice(user, device) {
  const r = await api('POST', '/_matrix/client/v3/login', {
    body: { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: PASSWORD, initial_device_display_name: device },
  });
  return { userId: r.user_id, token: r.access_token, deviceId: r.device_id };
}

/** The client's attachment module (AES-CTR via WebCrypto; Node 22 has `globalThis.crypto.subtle`). */
export async function loadAttachments() {
  return import('../../src/lib/matrix/attachment-crypto.ts');
}

/** Raw bytes of an mxc url via authenticated media (falls back to the legacy endpoint on 404). */
export async function downloadMedia(session, mxc) {
  const [server, mediaId] = mxc.slice('mxc://'.length).split('/');
  for (const base of ['/_matrix/client/v1/media/download', '/_matrix/media/v3/download']) {
    const res = await api('GET', `${base}/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`, { token: session.token, raw: true });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (res.status !== 404) throw new Error(`media download ${res.status}`);
  }
  throw new Error(`media not found: ${mxc}`);
}

/** Merge a room-key export (JSON array of IMegolmSessionData) into `file`, keyed by room + session id. */
export function mergeRoomKeys(file, exportedJson) {
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  const byId = new Map(existing.map((k) => [`${k.room_id}|${k.session_id}`, k]));
  for (const k of JSON.parse(exportedJson)) byId.set(`${k.room_id}|${k.session_id}`, k);
  const merged = [...byId.values()];
  // tmp + rename: parallel e2e workers can merge concurrently, a reader must never see a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmp, file);
  return merged.length;
}
