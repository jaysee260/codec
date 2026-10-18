/**
 * Static + runtime configuration for the Matrix layer.
 *
 * Homeserver URL resolution (Phase 2): a runtime override in localStorage (the login screen's
 * "Advanced" field, so a phone can point at the PC's LAN proxy) wins over the build-time
 * `VITE_HS_URL`, which wins over `http://localhost:8008`. Always read it through `getHsUrl()`;
 * the `HS_URL` constant only reflects the build-time default.
 */

const envUrl = (import.meta.env.VITE_HS_URL as string | undefined)?.trim();

/** Trim whitespace, add `http://` when no scheme was typed, drop trailing slashes. '' stays ''. */
export function normalizeHsUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/** Build-time default homeserver URL (no trailing slash): `VITE_HS_URL` or http://localhost:8008. */
export const DEFAULT_HS_URL: string = (envUrl && normalizeHsUrl(envUrl)) || 'http://localhost:8008';

/** @deprecated Build-time default only. Use `getHsUrl()` so the runtime override is honoured. */
export const HS_URL: string = DEFAULT_HS_URL;

/** localStorage key holding the runtime homeserver override (absent = use DEFAULT_HS_URL). */
export const HS_URL_STORAGE_KEY = 'matrix-poc.hsUrl';

/** Effective homeserver base URL: runtime override -> VITE_HS_URL -> http://localhost:8008. */
export function getHsUrl(): string {
  try {
    const stored = localStorage.getItem(HS_URL_STORAGE_KEY);
    if (stored) {
      const url = normalizeHsUrl(stored);
      if (url) return url;
    }
  } catch {
    /* no localStorage (tests, private mode) */
  }
  return DEFAULT_HS_URL;
}

/** True when a runtime override is in effect (login screen shows the Advanced section expanded). */
export function hasHsUrlOverride(): boolean {
  return getHsUrl() !== DEFAULT_HS_URL;
}

/**
 * Persist a runtime homeserver override. Empty / whitespace / equal to the build-time default
 * removes the override. Returns the effective URL.
 */
export function setHsUrl(input: string | null | undefined): string {
  const url = normalizeHsUrl(input ?? '');
  try {
    if (!url || url === DEFAULT_HS_URL) localStorage.removeItem(HS_URL_STORAGE_KEY);
    else localStorage.setItem(HS_URL_STORAGE_KEY, url);
  } catch {
    /* ignore quota / private mode */
  }
  return url || DEFAULT_HS_URL;
}

/** localStorage key holding the persisted session (user id, access token, device id). */
export const SESSION_STORAGE_KEY = 'matrix-poc.session';

/** localStorage key holding the last navigation selection ({ spaceId, roomId, lastRoomBySpace }). */
export const NAV_STORAGE_KEY = 'nav.selection';

/** Device name shown in the homeserver's device list. */
export const DEVICE_DISPLAY_NAME = 'Codec (web)';

/** Server name part of a user id: "@alice:localhost" -> "localhost". */
export function serverNameOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx >= 0 ? userId.slice(idx + 1) : 'localhost';
}

/** Local part of a user id: "@alice:localhost" -> "alice". */
export function localpartOf(userId: string): string {
  const idx = userId.indexOf(':');
  return userId.slice(1, idx >= 0 ? idx : undefined);
}
