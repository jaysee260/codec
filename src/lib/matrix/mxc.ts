import { getHsUrl } from './config.ts';

export type ThumbnailMethod = 'scale' | 'crop';

let authenticated = false;

/** Set by `media.ts` once it knows whether authenticated media URLs can be used. */
export function setAuthenticatedMedia(on: boolean): void {
  authenticated = on;
}

/**
 * Convert an mxc:// URI into an HTTP URL served by the homeserver.
 * - With width+height: a thumbnail URL (`method` defaults to 'scale'; use 'crop' for avatars).
 * - Without: the full download URL.
 * Returns '' for anything that is not an mxc URI, so it is safe to feed straight into `src`.
 *
 * URL family: authenticated `/_matrix/client/v1/media` when `media.ts` has switched it on (server supports it
 * and the media service worker adds the token), else the legacy unauthenticated `/_matrix/media/v3`.
 */
export function mxcToHttp(
  mxc: string | null | undefined,
  width?: number,
  height?: number,
  method: ThumbnailMethod = 'scale',
): string {
  if (!mxc || !mxc.startsWith('mxc://')) return '';
  const rest = mxc.slice('mxc://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return '';
  const server = encodeURIComponent(rest.slice(0, slash));
  const mediaId = encodeURIComponent(rest.slice(slash + 1));
  // Resolved per call: the runtime homeserver override (phones on the LAN proxy) must apply to media too.
  const base = `${getHsUrl()}${authenticated ? '/_matrix/client/v1/media' : '/_matrix/media/v3'}`;
  if (width && height) {
    return `${base}/thumbnail/${server}/${mediaId}?width=${Math.round(width)}&height=${Math.round(height)}&method=${method}`;
  }
  return `${base}/download/${server}/${mediaId}`;
}
