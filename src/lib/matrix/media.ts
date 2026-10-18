/**
 * Authenticated media (Matrix v1.11, `/_matrix/client/v1/media/*`).
 *
 * Servers with `enable_authenticated_media: true` (the Synapse default) refuse media requests without an
 * access token. `<img>` and `<audio>` can't send headers, so `public/media-sw.js` adds the token to those
 * requests; this module registers it, answers its token requests, and decides which URL family
 * `mxcToHttp()` returns:
 * - v1 (authenticated) when the server advertises it **and** the worker controls the page;
 * - the legacy unauthenticated `/_matrix/media/v3` otherwise (no service worker, e.g. plain-http LAN dev,
 *   or an old server). Those only work on servers with `enable_authenticated_media: false`.
 *
 * Links (open full image, download file) are navigations the worker can't see, so `openMedia()` /
 * `downloadMedia()` fetch the bytes with the token and hand the browser a `blob:` URL instead.
 */
import { SESSION_STORAGE_KEY } from './config.ts';
import { setAuthenticatedMedia } from './mxc.ts';
import { fetchDecryptedBlob, isEncryptedFile, type EncryptedFile } from './attachments.ts';

/** Phase 5: a media source is an http(s) URL (plain media, or an already decrypted `blob:`) or an `EncryptedFile`. */
export type MediaSource = string | EncryptedFile;

/** The source to open / download for a media body: the `EncryptedFile` when there is one, else the mxc url. */
export function mediaSourceOf(body: { file?: EncryptedFile | null; url?: string | null }): MediaSource | null {
  return body.file ?? body.url ?? null;
}

const SW_URL = `${import.meta.env.BASE_URL}media-sw.js`;
const CONTROL_TIMEOUT_MS = 3000;

let swActive = false;
let serverSupportsV1 = false;
let probedFor: string | null = null;

/** The persisted session's homeserver + token, read directly so this module doesn't import client.ts. */
function storedCreds(): { baseUrl: string; accessToken: string } | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? 'null') as { baseUrl?: string; accessToken?: string } | null;
    return s?.baseUrl && s.accessToken ? { baseUrl: s.baseUrl, accessToken: s.accessToken } : null;
  } catch {
    return null;
  }
}

/** Resolve after `ms` at the latest. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

function apply(): void {
  setAuthenticatedMedia(swActive && serverSupportsV1);
}

/**
 * Register the media worker and wait (bounded) until it controls the page. Call once before the first
 * render. Never throws: without a worker the app falls back to v3 URLs.
 */
export async function initMediaAuth(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const sw = navigator.serviceWorker;
  sw.addEventListener('message', (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type !== 'matrix-poc.media-auth') return;
    e.ports[0]?.postMessage(storedCreds());
  });
  sw.startMessages();
  try {
    await sw.register(SW_URL, { scope: import.meta.env.BASE_URL });
    const reg = await within(sw.ready, CONTROL_TIMEOUT_MS);
    if (reg && !sw.controller) {
      // First visit (the worker claims on activate) or a hard reload (an active worker doesn't control the page
      // until it claims again): ask it to claim, and wait for that, but never block startup long.
      const claimed = new Promise<void>((resolve) => sw.addEventListener('controllerchange', () => resolve(), { once: true }));
      reg.active?.postMessage({ type: 'matrix-poc.claim' });
      await within(claimed, CONTROL_TIMEOUT_MS);
    }
    swActive = !!sw.controller;
  } catch (e) {
    console.warn('[media] service worker unavailable, using unauthenticated media URLs', e);
    swActive = false;
  }
  apply();
}

/**
 * Ask the homeserver whether it speaks authenticated media (spec v1.11, or the MSC3916 stable flag).
 * Called before the client starts so the first render already uses the right URLs.
 */
export async function probeAuthenticatedMedia(baseUrl: string): Promise<void> {
  if (probedFor === baseUrl) return;
  // A transient failure here would pin the whole session to v3 URLs, so retry a few times.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/_matrix/client/versions`);
      if (!res.ok) throw new Error(`versions: ${res.status}`);
      const body = (await res.json()) as { versions?: string[]; unstable_features?: Record<string, boolean> };
      serverSupportsV1 =
        !!body.versions?.some((v) => /^v1\.(\d+)$/.test(v) && Number(v.slice(3)) >= 11) ||
        !!body.unstable_features?.['org.matrix.msc3916.stable'];
      probedFor = baseUrl;
      break;
    } catch {
      serverSupportsV1 = false;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  apply();
}

/** Same origin as `base`, without throwing on malformed URLs. */
function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** True for URLs that need the access token: `/_matrix/client/v1/media/...` on the session's own homeserver. */
function needsAuth(url: string): boolean {
  const creds = storedCreds();
  return !!creds && url.includes('/_matrix/client/v1/media/') && sameOrigin(url, creds.baseUrl);
}

/** `fetch()` for media URLs: adds the access token for authenticated media on the session's homeserver only. */
export function fetchMedia(url: string): Promise<Response> {
  const creds = needsAuth(url) ? storedCreds() : null;
  return fetch(url, creds ? { headers: { Authorization: `Bearer ${creds.accessToken}` } } : undefined);
}

/** Image types a browser renders as inert pixels; anything else (SVG, HTML, ...) could run script in our origin. */
const VIEWABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

/** Bytes of a media source: plain URL through `fetchMedia`, encrypted file decrypted (Phase 5). */
export async function fetchMediaBlob(source: MediaSource, mimetype?: string): Promise<Blob> {
  if (isEncryptedFile(source)) return fetchDecryptedBlob(source, mimetype);
  const res = await fetchMedia(source);
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return res.blob();
}

/**
 * Click handler for a link to full-size media. Unauthenticated URLs keep the native link behaviour;
 * authenticated ones open a tab synchronously (so popup blockers allow it) and point it at a blob.
 * A blob: URL lives in the app's origin and loses the homeserver's sandboxing headers, so only raster
 * images are opened this way; everything else, or a blocked popup, falls back to a download.
 * Phase 5: an `EncryptedFile` source is downloaded and decrypted first (never navigate to the raw mxc, it is
 * ciphertext); pass the event's `info.mimetype` so the tab / download gets the right type.
 */
export function openMedia(e: { preventDefault(): void }, source: MediaSource, name?: string, mimetype?: string): void {
  const encrypted = isEncryptedFile(source);
  if (!encrypted && !needsAuth(source)) return;
  e.preventDefault();
  const tab = window.open('', '_blank');
  if (!tab) {
    downloadMedia(e, source, name, mimetype);
    return;
  }
  fetchMediaBlob(source, mimetype)
    .then(async (blob) => {
      const type = blob.type.split(';')[0]!.trim().toLowerCase();
      if (!VIEWABLE_TYPES.has(type)) {
        tab.close();
        saveBlob(blob, name);
        return;
      }
      const blobUrl = URL.createObjectURL(new Blob([blob], { type }));
      tab.location.href = blobUrl;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    })
    .catch((err: unknown) => {
      tab.close();
      console.warn('[media] open failed', err);
    });
}

function saveBlob(blob: Blob, name: string | undefined): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

/** Click handler for a download link: like `openMedia`, but always saves the file under `name`. */
export function downloadMedia(e: { preventDefault(): void }, source: MediaSource, name: string | undefined, mimetype?: string): void {
  if (!isEncryptedFile(source) && !needsAuth(source)) return;
  e.preventDefault();
  fetchMediaBlob(source, mimetype)
    .then((blob) => saveBlob(blob, name))
    .catch((err: unknown) => console.warn('[media] download failed', err));
}
