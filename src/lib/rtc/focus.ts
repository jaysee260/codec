/**
 * Phase 7: where the call server is. Codec is the only client, so we pick one discovery order and keep it
 * (Advisor B2: try the authenticated unstable `/rtc/transports` route, fall back to the well-known `rtc_foci`):
 *
 *   1. an override: `localStorage['matrix-poc.rtcFocusUrl']` (phone pointed at a LAN stack) or `VITE_RTC_FOCUS_URL`;
 *   2. `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports` with the access token (Synapse 1.140+ behind
 *      `msc4143_enabled`; 404 / 401 / M_UNRECOGNIZED means "not here");
 *   3. `GET <homeserver base URL>/.well-known/matrix/client` (Synapse serves it on the client listener with CORS; this is
 *      what the local stack and a Synapse-served 704.chat well-known use);
 *   4. `GET https://<server name>/.well-known/matrix/client` (a well-known served by the reverse proxy instead).
 *
 * The parsers are pure (unit-tested); `discoverFocus` does the requests and caches per homeserver for the session.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { CallError, type LivekitFocus } from './types.ts';

export const RTC_FOCUS_STORAGE_KEY = 'matrix-poc.rtcFocusUrl';
export const RTC_FOCI_WELL_KNOWN_KEY = 'org.matrix.msc4143.rtc_foci';
export const RTC_TRANSPORTS_PATH = '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports';

/** Accepts a `livekit` focus with a usable http(s) `livekit_service_url`; everything else is skipped. */
export function parseFocus(value: unknown): LivekitFocus | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { type?: unknown; livekit_service_url?: unknown };
  if (v.type !== 'livekit' || typeof v.livekit_service_url !== 'string') return null;
  const url = v.livekit_service_url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return null;
  return { type: 'livekit', livekit_service_url: url };
}

/** The first usable LiveKit focus in a well-known document (`org.matrix.msc4143.rtc_foci`), or null. */
export function parseFociFromWellKnown(doc: unknown): LivekitFocus | null {
  if (!doc || typeof doc !== 'object') return null;
  const list = (doc as Record<string, unknown>)[RTC_FOCI_WELL_KNOWN_KEY];
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const focus = parseFocus(item);
    if (focus) return focus;
  }
  return null;
}

/** The first usable LiveKit focus in an `/rtc/transports` response (`rtc_transports`, older `rtc_foci`), or null. */
export function parseFociFromTransports(doc: unknown): LivekitFocus | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const list = Array.isArray(d.rtc_transports) ? d.rtc_transports : Array.isArray(d[RTC_FOCI_WELL_KNOWN_KEY]) ? d[RTC_FOCI_WELL_KNOWN_KEY] : null;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const focus = parseFocus(item);
    if (focus) return focus;
  }
  return null;
}

/** A focus from an override string (`http://192.168.1.5:7980`), or null when empty / not a URL. */
export function focusFromOverride(input: string | null | undefined): LivekitFocus | null {
  if (!input) return null;
  let url = input.trim();
  if (!url) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return parseFocus({ type: 'livekit', livekit_service_url: url });
}

function readOverride(): LivekitFocus | null {
  try {
    const stored = localStorage.getItem(RTC_FOCUS_STORAGE_KEY);
    const fromStorage = focusFromOverride(stored);
    if (fromStorage) return fromStorage;
  } catch {
    /* no localStorage */
  }
  const env = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_RTC_FOCUS_URL as string | undefined) : undefined;
  return focusFromOverride(env);
}

/** Persist (or clear, with an empty value) the runtime focus override. */
export function setFocusOverride(input: string | null | undefined): void {
  const focus = focusFromOverride(input);
  try {
    if (focus) localStorage.setItem(RTC_FOCUS_STORAGE_KEY, focus.livekit_service_url);
    else localStorage.removeItem(RTC_FOCUS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  cache.clear();
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

const cache = new Map<string, LivekitFocus>();

export interface DiscoverOptions {
  /** Bypass the per-homeserver cache (a failed token request re-discovers). */
  fresh?: boolean;
}

/**
 * Find the LiveKit focus for the client's homeserver (order in the file header). Throws `CallError('no-focus')`
 * when nothing answers. Cached per base URL until `setFocusOverride` or `fresh`.
 */
export async function discoverFocus(client: Pick<MatrixClient, 'baseUrl' | 'getAccessToken' | 'getUserId'>, opts: DiscoverOptions = {}): Promise<LivekitFocus> {
  const override = readOverride();
  if (override) return override;
  const base = client.baseUrl.replace(/\/+$/, '');
  if (!opts.fresh) {
    const hit = cache.get(base);
    if (hit) return hit;
  }
  const token = client.getAccessToken();
  const candidates: (() => Promise<LivekitFocus | null>)[] = [
    async () => parseFociFromTransports(await fetchJson(`${base}${RTC_TRANSPORTS_PATH}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)),
    async () => parseFociFromWellKnown(await fetchJson(`${base}/.well-known/matrix/client`)),
    async () => {
      const userId = client.getUserId();
      const server = userId?.slice(userId.indexOf(':') + 1);
      if (!server || server === 'localhost') return null;
      return parseFociFromWellKnown(await fetchJson(`https://${server}/.well-known/matrix/client`));
    },
  ];
  for (const probe of candidates) {
    const focus = await probe();
    if (focus) {
      cache.set(base, focus);
      return focus;
    }
  }
  throw new CallError('no-focus', 'This homeserver has no call server configured');
}

/** Test hook. */
export function clearFocusCache(): void {
  cache.clear();
}
