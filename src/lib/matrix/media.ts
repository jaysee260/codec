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
import { loadSession } from './client.ts';
import { setAuthenticatedMedia } from './mxc.ts';

const SW_URL = `${import.meta.env.BASE_URL}media-sw.js`;
const CONTROL_TIMEOUT_MS = 3000;

let swActive = false;
let serverSupportsV1 = false;

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
    const s = loadSession();
    e.ports[0]?.postMessage(s ? { baseUrl: s.baseUrl, accessToken: s.accessToken } : null);
  });
  sw.startMessages();
  try {
    await sw.register(SW_URL, { scope: import.meta.env.BASE_URL });
    await sw.ready;
    if (!sw.controller) {
      // First visit: the worker claims the page on activate; wait for that, but never block startup long.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CONTROL_TIMEOUT_MS);
        sw.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
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
  try {
    const res = await fetch(`${baseUrl}/_matrix/client/versions`);
    const body = (await res.json()) as { versions?: string[]; unstable_features?: Record<string, boolean> };
    serverSupportsV1 =
      !!body.versions?.some((v) => /^v1\.(\d+)$/.test(v) && Number(v.slice(3)) >= 11) ||
      !!body.unstable_features?.['org.matrix.msc3916.stable'];
  } catch {
    serverSupportsV1 = false;
  }
  apply();
}

/** True for URLs that need the access token (`/_matrix/client/v1/media/...` on the session's homeserver). */
function needsAuth(url: string): boolean {
  return url.includes('/_matrix/client/v1/media/');
}

/** `fetch()` for media URLs: adds the access token for authenticated media. */
export function fetchMedia(url: string): Promise<Response> {
  const s = needsAuth(url) ? loadSession() : null;
  return fetch(url, s ? { headers: { Authorization: `Bearer ${s.accessToken}` } } : undefined);
}

async function blobUrlOf(url: string): Promise<string> {
  const res = await fetchMedia(url);
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/**
 * Click handler for a link to full-size media. Unauthenticated URLs keep the native link behaviour;
 * authenticated ones open a tab synchronously (so popup blockers allow it) and point it at a blob.
 */
export function openMedia(e: { preventDefault(): void }, url: string): void {
  if (!needsAuth(url)) return;
  e.preventDefault();
  const tab = window.open('', '_blank');
  blobUrlOf(url).then(
    (blobUrl) => {
      if (tab) tab.location.href = blobUrl;
      else window.location.assign(blobUrl);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    },
    (err: unknown) => {
      tab?.close();
      console.warn('[media] open failed', err);
    },
  );
}

/** Click handler for a download link: like `openMedia`, but saves the file under `name`. */
export function downloadMedia(e: { preventDefault(): void }, url: string, name: string | undefined): void {
  if (!needsAuth(url)) return;
  e.preventDefault();
  blobUrlOf(url).then(
    (blobUrl) => {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    },
    (err: unknown) => console.warn('[media] download failed', err),
  );
}
