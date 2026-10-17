/**
 * Authenticated media service worker (served at /media-sw.js, scope /).
 *
 * Homeservers with `enable_authenticated_media: true` (the Synapse default) only serve media from
 * `/_matrix/client/v1/media/{download,thumbnail}` with an `Authorization: Bearer` header, which plain
 * `<img src>` / `<audio src>` tags cannot send. This worker adds the header to those requests, the same
 * approach as Element Web. It never stores the token: for every media request it asks the page that made
 * the request (see src/lib/matrix/media.ts), and only sends the token to that page's homeserver origin.
 */
// Unanchored: the homeserver may sit under a path prefix. The origin check below keeps the token on that server.
const MEDIA_PATH = /\/_matrix\/client\/v1\/media\/(download|thumbnail)\//;
const ASK_TIMEOUT_MS = 3000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// After a hard reload the page is uncontrolled even though this worker is active; the page asks it to claim again.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'matrix-poc.claim') event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('Authorization')) return;
  const url = new URL(req.url);
  if (!MEDIA_PATH.test(url.pathname)) return;
  event.respondWith(authedFetch(event.clientId, req, url));
});

async function authedFetch(clientId, req, url) {
  const creds = await askPage(clientId);
  if (!creds || !creds.accessToken || originOf(creds.baseUrl) !== url.origin) return fetch(req);
  const headers = { Authorization: `Bearer ${creds.accessToken}` };
  const range = req.headers.get('Range');
  if (range) headers.Range = range;
  return fetch(url.href, { headers, mode: 'cors', credentials: 'omit', redirect: 'follow' });
}

/** Ask the page for { baseUrl, accessToken } over a MessageChannel; null when it can't answer. */
async function askPage(clientId) {
  let client = clientId ? await self.clients.get(clientId) : undefined;
  if (!client) [client] = await self.clients.matchAll({ type: 'window' });
  if (!client) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data || null);
    };
    client.postMessage({ type: 'matrix-poc.media-auth' }, [channel.port2]);
  });
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
