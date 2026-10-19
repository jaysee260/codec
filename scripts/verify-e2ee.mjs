#!/usr/bin/env node
/**
 * No-browser check of the Phase 5 core (docs/archive/PHASE5_ACCEPTANCE.md AC-E7-4):
 *   1. attachments.ts round-trips a buffer under Node's WebCrypto (encrypt -> decrypt -> equal; tampering fails);
 *   2. the sample room (`--room`, default #vault:localhost) has the `m.room.encryption` state;
 *   3. the newest sample events there are `m.room.encrypted` with no plaintext;
 *   4. the newest encrypted image's media bytes are ciphertext (not a PNG) whose SHA-256 matches `file.hashes.sha256`
 *      (read from `seed/e2ee-keys.json`-decryptable history via a throwaway crypto client as alice).
 * Exit 0 when every check passes. Environment: HS_URL, PASSWORD.
 *
 *   npm run verify:e2ee
 */
import { createHash } from 'node:crypto';
import { api, HS, downloadMedia, loadAttachments, loginWithDevice, quietLogger, resolveRoom } from './lib/e2ee-api.mjs';
import { createClient, ClientEvent, SyncState } from 'matrix-js-sdk';

const args = process.argv.slice(2);
const value = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const roomArg = value('--room', '#vault:localhost');
const user = value('--as', 'alice');
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

// 1. attachment round trip
{
  const { encryptAttachment, decryptAttachment } = await loadAttachments();
  const plain = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
  const { data, info } = await encryptAttachment(plain.buffer);
  check(info.v === 'v2' && info.key.alg === 'A256CTR' && info.key.kty === 'oct' && !info.key.k.includes('='), 'EncryptedFile shape (v2, A256CTR, unpadded jwk k)');
  check(Buffer.from(info.iv, 'base64').length === 16 && Buffer.from(info.iv, 'base64').subarray(8).every((b) => b === 0), 'iv = 8 random bytes + 8 zero bytes');
  const back = new Uint8Array(await decryptAttachment(data, info));
  check(back.length === plain.length && back.every((b, i) => b === plain[i]), 'encrypt -> decrypt round trip');
  const tampered = new Uint8Array(data).slice();
  tampered[10] ^= 0xff;
  let threw = false;
  try {
    await decryptAttachment(tampered.buffer, info);
  } catch {
    threw = true;
  }
  check(threw, 'tampered ciphertext is rejected (hash mismatch)');
}

// 2-4. server-side checks
const session = await loginWithDevice(user, 'verify-e2ee');
const client = createClient({ baseUrl: HS, userId: session.userId, accessToken: session.token, deviceId: session.deviceId, timelineSupport: true, logger: quietLogger });
try {
  const roomId = await resolveRoom(session, roomArg);
  const stateRes = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`, { token: session.token, raw: true });
  const state = stateRes.ok ? await stateRes.json() : null;
  check(state?.algorithm === 'm.megolm.v1.aes-sha2', `${roomArg} has m.room.encryption (m.megolm.v1.aes-sha2)`);

  const messages = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`, { token: session.token });
  const encrypted = messages.chunk.filter((e) => e.type === 'm.room.encrypted');
  const plaintextMessages = messages.chunk.filter((e) => e.type === 'm.room.message');
  check(encrypted.length > 0, `newest 50 events include encrypted messages (${encrypted.length})`);
  check(plaintextMessages.length === 0, `no plaintext m.room.message in the newest 50 events (${plaintextMessages.length})`);
  check(encrypted.every((e) => !('body' in e.content) && e.content.algorithm === 'm.megolm.v1.aes-sha2'), 'encrypted events carry no body and the Megolm algorithm');

  // Decrypt the history with the sample keys to find the image and check its bytes.
  let imageFile = null;
  try {
    await client.initRustCrypto({ useIndexedDB: false });
    const { readFileSync } = await import('node:fs');
    const keys = readFileSync(value('--keys', 'seed/e2ee-keys.json'), 'utf8');
    await client.getCrypto().importRoomKeysAsJson(keys);
    await client.startClient({ initialSyncLimit: 5, lazyLoadMembers: true, threadSupport: true });
    await new Promise((resolve) => {
      const onSync = (s) => {
        if (s === SyncState.Prepared || s === SyncState.Syncing || s === SyncState.Error) {
          client.off(ClientEvent.Sync, onSync);
          resolve();
        }
      };
      client.on(ClientEvent.Sync, onSync);
    });
    for (const raw of encrypted) {
      const ev = client.getEventMapper()(raw);
      await client.decryptEventIfNeeded(ev);
      const c = ev.getContent();
      if (c.msgtype === 'm.image' && c.file?.url) {
        imageFile = c.file;
        break;
      }
    }
    check(!!imageFile, 'an encrypted image decrypts with seed/e2ee-keys.json');
  } catch (e) {
    check(false, `decrypting the sample history (${e instanceof Error ? e.message : e})`);
  }
  if (imageFile) {
    const bytes = await downloadMedia(session, imageFile.url);
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    check(!png.every((b, i) => bytes[i] === b), 'image bytes on the server are not a PNG (ciphertext)');
    const sha = createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
    check(sha === imageFile.hashes.sha256.replace(/=+$/, ''), 'ciphertext SHA-256 matches file.hashes.sha256');
  }
} finally {
  client.stopClient();
  await api('POST', '/_matrix/client/v3/logout', { token: session.token }).catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
