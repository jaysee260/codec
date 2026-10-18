#!/usr/bin/env node
/**
 * Post encrypted sample messages into an encrypted room as bob (Phase 5, PRIN-22; docs/PHASE5_ACCEPTANCE.md
 * AC-E7-2). A Node matrix-js-sdk client with the Rust crypto engine (in-memory store) sends `--count` texts
 * ("vault sample 1..N") and one encrypted image (e2e/fixtures/test-image.png, encrypted with the client's own
 * attachments.ts), asserts every event is `m.room.encrypted` on the wire, merges this device's room keys into
 * `--keys` (default $E2EE_KEYS_FILE or seed/e2ee-keys.json; `__matrixPoc.security.importRoomKeys(json)` reads it) and logs the device out.
 *
 *   npm run e2ee:sample                                  # bob -> #vault:localhost, 3 texts + 1 image
 *   node scripts/send-encrypted-sample.mjs --count 5 --no-image --as dave --room '!roomId:localhost'
 *
 * Prints JSON `{ roomId, eventIds, keys }` and exits 0. Environment: HS_URL (http://localhost:8008), PASSWORD.
 * Note: the device shares its Megolm session with every current member device, so an already-open browser
 * session of alice decrypts these live; a session opened later needs the keys file (or a key backup).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { api, HS, loadAttachments, loginWithDevice, mergeRoomKeys, quietLogger, resolveRoom } from './lib/e2ee-api.mjs';
import { createClient, ClientEvent, SyncState } from 'matrix-js-sdk';

const args = process.argv.slice(2);
const value = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const user = value('--as', 'bob');
const roomArg = value('--room', '#vault:localhost');
const count = Number(value('--count', '3'));
const withImage = !args.includes('--no-image');
// E2EE_KEYS_FILE: parallel e2e workers each point this at their own file (e2e/fixtures/seed.ts).
const keysFile = value('--keys', process.env.E2EE_KEYS_FILE ?? path.join('seed', 'e2ee-keys.json'));
const imagePath = value('--image', path.join('e2e', 'fixtures', 'test-image.png'));

const session = await loginWithDevice(user, 'send-encrypted-sample');
const client = createClient({ baseUrl: HS, userId: session.userId, accessToken: session.token, deviceId: session.deviceId, timelineSupport: true, logger: quietLogger });
try {
  const roomId = await resolveRoom(session, roomArg);
  await client.initRustCrypto({ useIndexedDB: false });
  await client.startClient({ initialSyncLimit: 5, lazyLoadMembers: true, threadSupport: true });
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
  const room = client.getRoom(roomId);
  if (!room) throw new Error(`room ${roomId} not in the initial sync`);
  if (!room.hasEncryptionStateEvent()) throw new Error(`${roomArg} has no m.room.encryption state; refusing to post plaintext`);

  const eventIds = [];
  for (let i = 1; i <= count; i++) {
    const { event_id } = await client.sendMessage(roomId, { msgtype: 'm.text', body: `vault sample ${i}` });
    eventIds.push(event_id);
  }
  if (withImage) {
    const { encryptAttachment } = await loadAttachments();
    const bytes = readFileSync(imagePath);
    const { data, info } = await encryptAttachment(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const upload = await fetch(`${HS}/_matrix/media/v3/upload?filename=encrypted`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
    const { content_uri } = await upload.json();
    if (!content_uri) throw new Error(`upload failed: ${upload.status}`);
    const { event_id } = await client.sendMessage(roomId, {
      msgtype: 'm.image',
      body: path.basename(imagePath),
      file: { url: content_uri, ...info },
      info: { mimetype: 'image/png', size: bytes.length, w: 64, h: 64 },
    });
    eventIds.push(event_id);
  }
  for (const id of eventIds) {
    const ev = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(id)}`, { token: session.token });
    if (ev.type !== 'm.room.encrypted' || ev.content?.algorithm !== 'm.megolm.v1.aes-sha2' || 'body' in (ev.content ?? {})) {
      throw new Error(`event ${id} is not encrypted on the wire: ${JSON.stringify(ev.content)}`);
    }
  }
  const keys = mergeRoomKeys(keysFile, await client.getCrypto().exportRoomKeysAsJson());
  console.log(JSON.stringify({ roomId, eventIds, keys: { file: keysFile, sessions: keys } }, null, 2));
} finally {
  client.stopClient();
  await api('POST', '/_matrix/client/v3/logout', { token: session.token }).catch(() => {});
}
process.exit(0);
