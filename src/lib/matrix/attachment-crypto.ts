/**
 * Pure attachment crypto (Phase 5): the spec "Sending encrypted attachments" scheme (AES-256-CTR, 64-bit counter,
 * SHA-256 over the ciphertext, JWK key) on WebCrypto only. No app imports, so Node scripts
 * (`scripts/send-encrypted-sample.mjs`, `scripts/verify-e2ee.mjs`) load it as-is; the browser uses it through
 * `attachments.ts`, which re-exports everything here and adds the download/blob-URL side.
 */
/** The spec `EncryptedFile` object (`file` / `info.thumbnail_file` in media events). */
export interface EncryptedFile {
  url: string;
  key: { kty: 'oct'; alg: 'A256CTR'; ext: true; key_ops: string[]; k: string };
  iv: string;
  hashes: { sha256: string };
  v: 'v2';
}

/** Everything but the mxc url: what `encryptAttachment` produces before the upload. */
export type EncryptedFileInfo = Omit<EncryptedFile, 'url'>;

function toBase64(bytes: Uint8Array, opts: { url?: boolean; pad?: boolean } = {}): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  let out = btoa(s);
  if (opts.url) out = out.replace(/\+/g, '-').replace(/\//g, '_');
  if (opts.pad === false) out = out.replace(/=+$/, '');
  return out;
}

function fromBase64(input: string): Uint8Array<ArrayBuffer> {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Encrypted attachments need a secure context (https or localhost)');
  return s;
}

/** Encrypt bytes for upload. Returns the ciphertext and the `file` fields (minus `url`). */
export async function encryptAttachment(plaintext: ArrayBuffer): Promise<{ data: ArrayBuffer; info: EncryptedFileInfo }> {
  const sc = subtle();
  // 16-byte counter block: 8 random bytes + 8 zero bytes (counter), counter length 64 bits (spec).
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const key = await sc.generateKey({ name: 'AES-CTR', length: 256 }, true, ['encrypt', 'decrypt']);
  const data = await sc.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, plaintext);
  const jwk = await sc.exportKey('jwk', key);
  const digest = new Uint8Array(await sc.digest('SHA-256', data));
  return {
    data,
    info: {
      v: 'v2',
      key: { kty: 'oct', alg: 'A256CTR', ext: true, key_ops: ['encrypt', 'decrypt'], k: jwk.k! },
      iv: toBase64(iv),
      hashes: { sha256: toBase64(digest, { pad: false }) },
    },
  };
}

/** Decrypt downloaded bytes with an `EncryptedFile`. Throws when the hash does not match or the shape is wrong. */
export async function decryptAttachment(ciphertext: ArrayBuffer, file: EncryptedFileInfo): Promise<ArrayBuffer> {
  const sc = subtle();
  if (file.v !== 'v2' && (file as { v?: string }).v !== 'v1') throw new Error(`Unsupported encrypted file version ${String(file.v)}`);
  if (file.key?.alg !== 'A256CTR' || file.key.kty !== 'oct' || !file.key.k) throw new Error('Unsupported attachment key');
  const expected = (file.hashes?.sha256 ?? '').replace(/=+$/, '');
  if (!expected) throw new Error('Attachment has no sha256 hash');
  const digest = toBase64(new Uint8Array(await sc.digest('SHA-256', ciphertext)), { pad: false });
  if (digest !== expected) throw new Error('Attachment hash mismatch');
  const key = await sc.importKey('jwk', { kty: 'oct', alg: 'A256CTR', ext: true, key_ops: ['encrypt', 'decrypt'], k: file.key.k }, { name: 'AES-CTR' }, false, ['decrypt']);
  const iv = fromBase64(file.iv);
  if (iv.length !== 16) throw new Error('Attachment iv must be 16 bytes');
  return sc.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, ciphertext);
}

/** Shape guard: true when `value` looks like a spec `EncryptedFile`. */
export function isEncryptedFile(value: unknown): value is EncryptedFile {
  const f = value as Partial<EncryptedFile> | null;
  return !!f && typeof f === 'object' && typeof f.url === 'string' && f.url.startsWith('mxc://') && !!f.key && typeof f.key.k === 'string' && typeof f.iv === 'string' && typeof f.hashes?.sha256 === 'string';
}
