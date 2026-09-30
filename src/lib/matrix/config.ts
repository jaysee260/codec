/** Static configuration for the Matrix layer. Read once at module load. */

const envUrl = (import.meta.env.VITE_HS_URL as string | undefined)?.trim();

/** Homeserver base URL (no trailing slash). Override with VITE_HS_URL in .env. */
export const HS_URL: string = (envUrl && envUrl.replace(/\/+$/, '')) || 'http://localhost:8008';

/** localStorage key holding the persisted session (user id, access token, device id). */
export const SESSION_STORAGE_KEY = 'matrix-poc.session';

/** localStorage key holding the last navigation selection ({ spaceId, roomId, lastRoomBySpace }). */
export const NAV_STORAGE_KEY = 'nav.selection';

/** Device name shown in the homeserver's device list. */
export const DEVICE_DISPLAY_NAME = 'Matrix POC (web)';

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
