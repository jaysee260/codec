/**
 * Unit tests for Element's key export format (key-export.ts). Run: `npm run test:unit` (node:test, Node 22 type
 * stripping). Small PBKDF2 round counts keep it fast; one check decrypts with node:crypto, independently of the
 * module, so a self-consistent but wrong layout cannot pass on round trips alone.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { DEFAULT_EXPORT_ROUNDS, KeyExportError, decryptMegolmKeyExport, encryptMegolmKeyExport } from './key-export.ts';

const HEADER = '-----BEGIN MEGOLM SESSION DATA-----';
const FOOTER = '-----END MEGOLM SESSION DATA-----';
const ROUNDS = 10;

/** A realistic plaintext: the shape `exportRoomKeysAsJson` produces (long enough for several 96-char lines). */
const SESSIONS = JSON.stringify(
  Array.from({ length: 3 }, (_, i) => ({
    algorithm: 'm.megolm.v1.aes-sha2',
    room_id: `!room${i}:localhost`,
    sender_key: `curve25519senderkey${i}`.padEnd(43, 'A'),
    session_id: `session${i}`.padEnd(43, 'B'),
    session_key: 'AQAAAAAAAAAA'.padEnd(300, 'C'),
    sender_claimed_keys: { ed25519: `ed${i}`.padEnd(43, 'D') },
    forwarding_curve25519_key_chain: [],
  })),
);

const bodyLines = (file: string): string[] => {
  const lines = file.split('\n');
  return lines.slice(lines.indexOf(HEADER) + 1, lines.indexOf(FOOTER));
};

const isKind = (kind: string) => (e: unknown): boolean => {
  assert.ok(e instanceof KeyExportError, `KeyExportError, got ${String(e)}`);
  assert.equal(e.kind, kind);
  assert.ok(e.message.length > 0, 'user-facing message');
  return true;
};

/** Rebuilds an armoured file around arbitrary bytes. */
const armourBytes = (bytes: Uint8Array): string => [HEADER, Buffer.from(bytes).toString('base64'), FOOTER, ''].join('\n');

describe('key export: round trip and format', () => {
  test('encrypt -> decrypt returns the same JSON', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'correct horse', { rounds: ROUNDS });
    assert.equal(await decryptMegolmKeyExport(file, 'correct horse'), SESSIONS);
  });

  test('unicode passphrase and an empty session list round-trip', async () => {
    const file = await encryptMegolmKeyExport('[]', 'pässwörd ✓', { rounds: ROUNDS });
    assert.equal(await decryptMegolmKeyExport(file, 'pässwörd ✓'), '[]');
  });

  test('armour: header, 96-char base64 lines, footer, trailing newline', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'pw', { rounds: ROUNDS });
    assert.ok(file.startsWith(`${HEADER}\n`));
    assert.ok(file.endsWith(`${FOOTER}\n`));
    const lines = bodyLines(file);
    assert.ok(lines.length > 2, 'several body lines');
    for (const l of lines.slice(0, -1)) assert.equal(l.length, 96);
    assert.ok(lines.at(-1)!.length <= 96 && lines.at(-1)!.length > 0);
    for (const l of lines) assert.match(l, /^[A-Za-z0-9+/=]+$/);
  });

  test('CRLF line endings (a file saved on Windows) decrypt', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'pw', { rounds: ROUNDS });
    assert.equal(await decryptMegolmKeyExport(file.replace(/\n/g, '\r\n'), 'pw'), SESSIONS);
  });

  test('other line lengths, surrounding whitespace and text around the block decrypt', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'pw', { rounds: ROUNDS });
    const b64 = bodyLines(file).join('');
    const rewrapped = ['some preamble', `  ${HEADER}  `, ...(b64.match(/.{1,64}/g) ?? []).map((l) => ` ${l} `), FOOTER, 'trailer'].join('\n');
    assert.equal(await decryptMegolmKeyExport(rewrapped, 'pw'), SESSIONS);
  });

  test('layout matches the spec (independent decrypt with node:crypto): v1 | salt | iv | rounds BE | ct | hmac', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'pw', { rounds: 1234 });
    const body = Buffer.from(bodyLines(file).join(''), 'base64');
    assert.equal(body[0], 1, 'version byte');
    const salt = body.subarray(1, 17);
    const iv = body.subarray(17, 33);
    assert.equal(body.readUInt32BE(33), 1234, 'rounds, big-endian');
    assert.equal(iv[8]! & 0x80, 0, 'bit 63 of the counter is clear (Element)');
    const ct = body.subarray(37, body.length - 32);
    const mac = body.subarray(body.length - 32);
    const keys = pbkdf2Sync('pw', salt, 1234, 64, 'sha512');
    const expectedMac = createHmac('sha256', keys.subarray(32)).update(body.subarray(0, body.length - 32)).digest();
    assert.ok(timingSafeEqual(mac, expectedMac), 'HMAC-SHA-256 over everything before it, with the second 32 bytes');
    const decipher = createDecipheriv('aes-256-ctr', keys.subarray(0, 32), iv);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    assert.equal(plain, SESSIONS);
  });

  test('the default round count is Element\'s 500000', () => {
    assert.equal(DEFAULT_EXPORT_ROUNDS, 500000);
  });
});

describe('key export: errors', () => {
  test('wrong passphrase -> kind passphrase', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'right', { rounds: ROUNDS });
    await assert.rejects(decryptMegolmKeyExport(file, 'wrong'), isKind('passphrase'));
  });

  test('a tampered ciphertext byte -> kind passphrase (HMAC mismatch), never garbage JSON', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'pw', { rounds: ROUNDS });
    const body = Buffer.from(bodyLines(file).join(''), 'base64');
    body[40] = body[40]! ^ 0x01;
    await assert.rejects(decryptMegolmKeyExport(armourBytes(body), 'pw'), isKind('passphrase'));
  });

  test('no armour (a plain JSON export, an empty file, random text) -> kind format', async () => {
    for (const text of [SESSIONS, '', 'hello world', HEADER, `${FOOTER}\n${HEADER}`]) {
      await assert.rejects(decryptMegolmKeyExport(text, 'pw'), isKind('format'), JSON.stringify(text.slice(0, 40)));
    }
  });

  test('armour around something that is not base64 -> kind format', async () => {
    await assert.rejects(decryptMegolmKeyExport(`${HEADER}\n!!!! not base64 ****\n${FOOTER}\n`, 'pw'), isKind('format'));
  });

  test('too short (armour around a few bytes, or nothing) -> kind format', async () => {
    await assert.rejects(decryptMegolmKeyExport(armourBytes(new Uint8Array([1, 2, 3, 4, 5])), 'pw'), isKind('format'));
    await assert.rejects(decryptMegolmKeyExport(`${HEADER}\n${FOOTER}\n`, 'pw'), isKind('format'));
  });

  test('unsupported version byte -> kind format', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'pw', { rounds: ROUNDS });
    const body = Buffer.from(bodyLines(file).join(''), 'base64');
    body[0] = 2;
    await assert.rejects(decryptMegolmKeyExport(armourBytes(body), 'pw'), isKind('format'));
  });

  test('zero PBKDF2 rounds -> kind format', async () => {
    const file = await encryptMegolmKeyExport(SESSIONS, 'pw', { rounds: ROUNDS });
    const body = Buffer.from(bodyLines(file).join(''), 'base64');
    body.writeUInt32BE(0, 33);
    await assert.rejects(decryptMegolmKeyExport(armourBytes(body), 'pw'), isKind('format'));
  });

  test('a valid file whose plaintext is not a JSON array -> kind format', async () => {
    for (const plain of ['{"not":"an array"}', 'plain text']) {
      const file = await encryptMegolmKeyExport(plain, 'pw', { rounds: ROUNDS });
      await assert.rejects(decryptMegolmKeyExport(file, 'pw'), isKind('format'), plain);
    }
  });
});
