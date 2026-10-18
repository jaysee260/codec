/**
 * Encrypted attachments (Phase 5). The Matrix spec encrypts a file with AES-256-CTR before upload and ships the
 * key with the event as an `EncryptedFile` (`file` instead of `url`): spec "Sending encrypted attachments",
 * the same scheme as Element's matrix-encrypt-attachment, implemented here on WebCrypto directly (the SDK has
 * no helper and we don't add dependencies).
 *
 *   file: { url: 'mxc://...', v: 'v2', key: { kty: 'oct', alg: 'A256CTR', ext: true, key_ops: ['encrypt','decrypt'], k },
 *           iv: <base64 16 bytes, low 64 bits zero>, hashes: { sha256: <unpadded base64 of the ciphertext> } }
 *
 * Upload side: `uploadEncryptedMedia(blob) -> EncryptedFile` (uploads as application/octet-stream; the server
 * never sees the plaintext or the mimetype). Display side: `fetchDecryptedMedia(file, mimetype) -> blob: URL`,
 * through `fetchMedia` so authenticated media works. There are **no server thumbnails** for encrypted media
 * (the server can't read it): render the decrypted full file, or `info.thumbnail_file` when the sender made one.
 * Needs `crypto.subtle`, i.e. a secure context (https or localhost); the plain-http LAN proxy has none.
 */
import { mxcToHttp } from './mxc.ts';
import { fetchMedia } from './media.ts';

import { decryptAttachment, type EncryptedFile } from './attachment-crypto.ts';

export { encryptAttachment, decryptAttachment, isEncryptedFile, type EncryptedFile, type EncryptedFileInfo } from './attachment-crypto.ts';

// ---------------------------------------------------------------------------
// Download + decrypt (display side)
// ---------------------------------------------------------------------------

const urlCache = new Map<string, Promise<string>>();

/**
 * Download an encrypted attachment (authenticated media aware), verify and decrypt it, and return a `blob:` URL
 * typed as `mimetype` (from the event's `info.mimetype`; `application/octet-stream` otherwise). Cached per mxc
 * url for the session: the same URL is returned to every caller, so **do not revoke it yourself**; call
 * `releaseDecryptedMedia(file)` when a room's media should be dropped (rare; the cache is small). Rejects on
 * network errors, hash mismatch or a non-secure context.
 */
export function fetchDecryptedMedia(file: EncryptedFile, mimetype?: string): Promise<string> {
  const cacheKey = `${file.url}|${mimetype ?? ''}`;
  let pending = urlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const http = mxcToHttp(file.url);
      if (!http) throw new Error('Invalid mxc url');
      const res = await fetchMedia(http);
      if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
      const plain = await decryptAttachment(await res.arrayBuffer(), file);
      return URL.createObjectURL(new Blob([plain], { type: safeType(mimetype) }));
    })();
    urlCache.set(cacheKey, pending);
    pending.catch(() => urlCache.delete(cacheKey));
  }
  return pending;
}

/** Download + decrypt into a Blob (no object URL): for `downloadMedia`-style save links. */
export async function fetchDecryptedBlob(file: EncryptedFile, mimetype?: string): Promise<Blob> {
  const http = mxcToHttp(file.url);
  if (!http) throw new Error('Invalid mxc url');
  const res = await fetchMedia(http);
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  const plain = await decryptAttachment(await res.arrayBuffer(), file);
  return new Blob([plain], { type: safeType(mimetype) });
}

/** Revoke and forget the cached blob URL(s) of an encrypted file. */
export function releaseDecryptedMedia(file: EncryptedFile): void {
  for (const [key, pending] of urlCache) {
    if (!key.startsWith(`${file.url}|`)) continue;
    urlCache.delete(key);
    void pending.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
}

/** Image/audio/video types are kept; anything that could run script in our origin (SVG, HTML) is neutralised. */
function safeType(mimetype: string | undefined): string {
  const t = (mimetype ?? '').split(';')[0]!.trim().toLowerCase();
  if (!t || t === 'image/svg+xml' || t.startsWith('text/html') || t.includes('xml') || t.includes('javascript')) return 'application/octet-stream';
  return t;
}
