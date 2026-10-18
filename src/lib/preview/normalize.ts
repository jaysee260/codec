/**
 * `/preview_url` answer -> `LinkPreview` (Phase 6). Pure module.
 *
 * Synapse returns flat OpenGraph keys (`og:title`, `og:image`, ...; numbers may arrive as strings on some
 * servers), `og:image` already re-hosted as an `mxc://` URI. Anything that is not mxc is dropped (never load a
 * third-party image from the timeline). An answer with no title, description or image normalises to `null`.
 */
import type { LinkPreview, LinkPreviewImage } from './types.ts';

/** Loose wire shape: whatever the server sends; `matrix-js-sdk`'s `IPreviewUrlResponse` is assignable. */
export type RawUrlPreview = Record<string, unknown>;

const MAX_TEXT = 2000;

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_TEXT) : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** `mxc://server/id` and nothing else. */
export function isMxcUrl(v: unknown): v is string {
  return typeof v === 'string' && /^mxc:\/\/[^/\s]+\/[^/\s]+$/.test(v);
}

export function normalizePreview(url: string, raw: RawUrlPreview | null | undefined): LinkPreview | null {
  if (!raw || typeof raw !== 'object') return null;
  const preview: LinkPreview = { url };
  const siteName = str(raw['og:site_name']);
  const title = str(raw['og:title']);
  const description = str(raw['og:description']);
  if (siteName) preview.siteName = siteName;
  if (title) preview.title = title;
  if (description) preview.description = description;
  if (isMxcUrl(raw['og:image'])) {
    const image: LinkPreviewImage = { mxc: raw['og:image'] };
    const width = num(raw['og:image:width']);
    const height = num(raw['og:image:height']);
    const mimetype = str(raw['og:image:type']);
    const size = num(raw['matrix:image:size']);
    if (width) image.width = width;
    if (height) image.height = height;
    if (mimetype) image.mimetype = mimetype;
    if (size) image.size = size;
    preview.image = image;
  }
  // A title that merely repeats the URL (Synapse falls back to it) is no preview on its own.
  if (preview.title && !preview.description && !preview.image && preview.title === url) return null;
  return preview.title || preview.description || preview.image ? preview : null;
}

/**
 * Layout hint (brief decision 3): a wide image renders large under the text, anything else as a side thumbnail.
 * Unknown dimensions -> thumbnail (the box must be reserved before the bytes arrive).
 */
export function previewImageLayout(image: LinkPreviewImage | undefined, minWidth = 400): 'large' | 'thumbnail' | 'none' {
  if (!image) return 'none';
  if (image.width && image.height && image.width >= minWidth && image.width > image.height) return 'large';
  return 'thumbnail';
}
