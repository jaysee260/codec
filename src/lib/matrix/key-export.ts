/**
 * Element's "Export E2E room keys" file format (MegolmExportEncryption in matrix-react-sdk), in WebCrypto only.
 * This is the way into history when the key backup cannot be opened (its secret sits under a secret storage key
 * the user no longer has) and no device gossips the backup key: export the room keys from a device that can
 * still read them (Element: Settings > Encryption > Advanced > Export keys) and import the file here.
 *
 * File: an ASCII-armoured block
 *   -----BEGIN MEGOLM SESSION DATA-----
 *   <base64, any line length (Element writes 96 chars per line)>
 *   -----END MEGOLM SESSION DATA-----
 * Payload (bytes): 0x01 (version) | salt (16) | IV (16) | PBKDF2 rounds (4, big-endian) | ciphertext | HMAC (32).
 * Keys: PBKDF2-SHA-512(passphrase, salt, rounds) -> 64 bytes: the first 32 are the AES-256-CTR key (counter =
 * the IV, counter length 64 bits), the last 32 the HMAC-SHA-256 key; the HMAC covers everything before it.
 * Plaintext: the UTF-8 JSON array of session objects that `CryptoApi.importRoomKeysAsJson` accepts.
 *
 * A wrong passphrase shows up as an HMAC mismatch (`KeyExportError` kind `passphrase`), anything malformed as kind
 * `format`; `message` is user text. Importable from plain Node 22 (the unit test): `globalThis.crypto.subtle`,
 * `atob` / `btoa`, no `@/` imports, no constructor parameter properties, nothing runs at import time.
 */

const HEADER = '-----BEGIN MEGOLM SESSION DATA-----';
const FOOTER = '-----END MEGOLM SESSION DATA-----';
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 16;
const ROUNDS_BYTES = 4;
const HMAC_BYTES = 32;
/** Element's default PBKDF2 iteration count for exports. */
export const DEFAULT_EXPORT_ROUNDS = 500000;

export type KeyExportErrorKind = 'passphrase' | 'format';

/** Why a key export file could not be decrypted: `passphrase` = HMAC mismatch, `format` = not an export file. */
export class KeyExportError extends Error {
  readonly kind: KeyExportErrorKind;
  constructor(kind: KeyExportErrorKind, message: string) {
    super(message);
    this.name = 'KeyExportError';
    this.kind = kind;
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Importing keys needs a secure context (https or localhost)');
  return s;
}

async function deriveKeys(passphrase: string, salt: Uint8Array<ArrayBuffer>, rounds: number): Promise<{ aes: CryptoKey; hmac: CryptoKey }> {
  const s = subtle();
  const base = await s.importKey('raw', new TextEncoder().encode(passphrase), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = new Uint8Array(await s.deriveBits({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-512' }, base, 512));
  const [aes, hmac] = await Promise.all([
    s.importKey('raw', bits.slice(0, 32), { name: 'AES-CTR' }, false, ['encrypt', 'decrypt']),
    s.importKey('raw', bits.slice(32), { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign', 'verify']),
  ]);
  return { aes, hmac };
}

/** The base64 body between the armour lines, decoded; throws `format` when there is none. */
function unarmour(fileText: string): Uint8Array<ArrayBuffer> {
  const lines = fileText.split(/\r?\n/).map((l) => l.trim());
  const start = lines.indexOf(HEADER);
  const end = start < 0 ? -1 : lines.indexOf(FOOTER, start + 1);
  if (start < 0 || end < 0) throw new KeyExportError('format', 'This is not an Element key export file (no MEGOLM SESSION DATA block)');
  const b64 = lines.slice(start + 1, end).join('');
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new KeyExportError('format', 'The key export file is damaged (not base64)');
  }
}

function armour(body: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < body.length; i += 0x8000) bin += String.fromCharCode(...body.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,96}/g) ?? [];
  return [HEADER, ...lines, FOOTER, ''].join('\n');
}

/**
 * Decrypt an Element key export (`fileText` = the whole file) with its passphrase. Resolves the plaintext JSON
 * (an array of exported sessions, checked to parse as an array). Throws `KeyExportError` (`passphrase` / `format`).
 */
export async function decryptMegolmKeyExport(fileText: string, passphrase: string): Promise<string> {
  const body = unarmour(fileText);
  const min = 1 + SALT_BYTES + IV_BYTES + ROUNDS_BYTES + HMAC_BYTES;
  if (body.length < min) throw new KeyExportError('format', 'The key export file is too short');
  if (body[0] !== VERSION) throw new KeyExportError('format', `Unsupported key export version ${body[0]}`);
  const salt = body.slice(1, 1 + SALT_BYTES);
  const iv = body.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
  const r = 1 + SALT_BYTES + IV_BYTES;
  const rounds = ((body[r]! << 24) | (body[r + 1]! << 16) | (body[r + 2]! << 8) | body[r + 3]!) >>> 0;
  if (rounds < 1) throw new KeyExportError('format', 'The key export file is damaged (no PBKDF2 rounds)');
  const ciphertext = body.slice(r + ROUNDS_BYTES, body.length - HMAC_BYTES);
  const mac = body.slice(body.length - HMAC_BYTES);
  const { aes, hmac } = await deriveKeys(passphrase, salt, rounds);
  const ok = await subtle().verify({ name: 'HMAC' }, hmac, mac, body.slice(0, body.length - HMAC_BYTES));
  if (!ok) throw new KeyExportError('passphrase', 'Incorrect passphrase for this key file');
  const plain = await subtle().decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aes, ciphertext);
  const json = new TextDecoder().decode(plain);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new KeyExportError('format', 'The key export file does not contain room keys');
  }
  if (!Array.isArray(parsed)) throw new KeyExportError('format', 'The key export file does not contain room keys');
  return json;
}

/**
 * Encrypt `json` (exported sessions) into Element's export format: the inverse of `decryptMegolmKeyExport`, for
 * tests and fixtures. `rounds` defaults to Element's 500000 (pass something small in tests).
 */
export async function encryptMegolmKeyExport(json: string, passphrase: string, opts: { rounds?: number } = {}): Promise<string> {
  const rounds = opts.rounds ?? DEFAULT_EXPORT_ROUNDS;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  // Like Element: clear bit 63 of the counter so the 64-bit counter half cannot wrap within one file.
  iv[8] = iv[8]! & 0x7f;
  const { aes, hmac } = await deriveKeys(passphrase, salt, rounds);
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aes, new TextEncoder().encode(json)));
  const head = 1 + SALT_BYTES + IV_BYTES + ROUNDS_BYTES;
  const body = new Uint8Array(head + ciphertext.length + HMAC_BYTES);
  body[0] = VERSION;
  body.set(salt, 1);
  body.set(iv, 1 + SALT_BYTES);
  body[head - 4] = (rounds >>> 24) & 0xff;
  body[head - 3] = (rounds >>> 16) & 0xff;
  body[head - 2] = (rounds >>> 8) & 0xff;
  body[head - 1] = rounds & 0xff;
  body.set(ciphertext, head);
  const mac = new Uint8Array(await subtle().sign({ name: 'HMAC' }, hmac, body.subarray(0, head + ciphertext.length)));
  body.set(mac, head + ciphertext.length);
  return armour(body);
}
