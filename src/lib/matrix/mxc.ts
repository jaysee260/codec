import { getHsUrl } from './config.ts';

export type ThumbnailMethod = 'scale' | 'crop';

/**
 * Convert an mxc:// URI into an HTTP URL served by the homeserver.
 * - With width+height: a thumbnail URL (`method` defaults to 'scale'; use 'crop' for avatars).
 * - Without: the full download URL.
 * Returns '' for anything that is not an mxc URI, so it is safe to feed straight into `src`.
 *
 * NOTE: the POC homeserver runs with `enable_authenticated_media: false`, so these
 * unauthenticated /_matrix/media/v3 URLs work directly in <img> tags.
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
  const base = `${getHsUrl()}/_matrix/media/v3`;
  if (width && height) {
    return `${base}/thumbnail/${server}/${mediaId}?width=${Math.round(width)}&height=${Math.round(height)}&method=${method}`;
  }
  return `${base}/download/${server}/${mediaId}`;
}
