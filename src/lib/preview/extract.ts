/**
 * Which links in a message get a preview card (Phase 6, brief decision 1). Pure module (no DOM, no SDK): the
 * HTML body is scanned with regexes, not `DOMParser`, so Node tests can import it.
 *
 * Rules: http(s) only; links inside `<pre>` / `<code>` (HTML bodies) are skipped; so are matrix.to links, links to
 * the homeserver's own media endpoints, and whole messages that are GIFs, redacted, media (`m.image`, ...) or not
 * decrypted. Duplicates collapse on the hash-stripped URL; the first `max` (default 3) survive, in message order.
 */
import type { ExtractOptions, PreviewSource } from './types.ts';

export const PREVIEW_MAX_LINKS = 3;

/** Message types whose body is prose. `m.notice` is included on purpose (bridged messages carry links too). */
const PROSE_MSGTYPES = new Set(['m.text', 'm.notice', 'm.emote']);

/** Same shape as `format.ts` URL_RE; `&` is not a terminator so `&amp;` in HTML text survives until decoding. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** HTML scan: an anchor's href, any other tag (consumed so attribute URLs are not read as text), or a raw URL. */
const HTML_TOKEN_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>|<[^>]+>|(https?:\/\/[^\s<>"'`]+)/gi;
const CODE_BLOCK_RE = /<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const MX_REPLY_RE = /<mx-reply\b[^>]*>[\s\S]*?<\/mx-reply\s*>/gi;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Drop the punctuation prose attaches to a link: "see https://a.b/c." / "(https://a.b/c)". */
function trimTrailingPunctuation(raw: string): string {
  let s = raw.replace(/[.,;:!?'"]+$/g, '');
  // A closing bracket only belongs to the URL when it is balanced ("https://en.wikipedia.org/wiki/Foo_(bar)").
  while (/[)\]}]$/.test(s)) {
    const close = s[s.length - 1];
    const open = close === ')' ? '(' : close === ']' ? '[' : '{';
    const opens = s.split(open).length - 1;
    const closes = s.split(close).length - 1;
    if (closes > opens) s = s.slice(0, -1).replace(/[.,;:!?'"]+$/g, '');
    else break;
  }
  return s;
}

function mediaPathOf(hsUrl: string | undefined): { origin: string; prefix: string } | null {
  if (!hsUrl) return null;
  try {
    const u = new URL(hsUrl);
    return { origin: u.origin, prefix: u.pathname.replace(/\/+$/, '') };
  } catch {
    return null;
  }
}

/**
 * Normalise one candidate: trailing punctuation off, must parse as http(s) with a host and no credentials,
 * not matrix.to, not the homeserver's media. Returns the hash-stripped URL or null.
 */
export function normalizePreviewUrl(candidate: string, opts: ExtractOptions = {}): string | null {
  const trimmed = trimTrailingPunctuation(decodeEntities(candidate.trim()));
  if (!trimmed || trimmed.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host === 'matrix.to' || host === 'www.matrix.to') return null;
  const hs = mediaPathOf(opts.hsUrl);
  if (hs && u.origin === hs.origin) {
    const p = u.pathname.startsWith(hs.prefix) ? u.pathname.slice(hs.prefix.length) : u.pathname;
    if (p.startsWith('/_matrix/media/') || p.startsWith('/_matrix/client/v1/media/') || p.startsWith('/_matrix/client/unstable/org.matrix.msc3916/media/')) {
      return null;
    }
  }
  u.hash = '';
  return u.toString();
}

/** URLs in a plain-text body, in order, before normalisation. */
function candidatesFromText(text: string): string[] {
  return Array.from(text.matchAll(URL_RE), (m) => m[0]);
}

/** URLs in an HTML body, in document order: anchors' hrefs plus raw URLs in text nodes; code/pre/mx-reply removed. */
function candidatesFromHtml(html: string): string[] {
  const stripped = html.replace(MX_REPLY_RE, ' ').replace(CODE_BLOCK_RE, ' ');
  const out: string[] = [];
  for (const m of stripped.matchAll(HTML_TOKEN_RE)) {
    const href = m[1] ?? m[2];
    if (href !== undefined) {
      if (/^\s*https?:/i.test(href)) out.push(href);
      continue;
    }
    if (m[3]) out.push(m[3]);
  }
  return out;
}

/**
 * The links of a message that get a preview card, in message order, deduplicated, at most `opts.max` (3).
 * Accepts a `DisplayBody` (src/lib/matrix/utils.ts `getDisplayBody(event)`), any `PreviewSource`, or a plain
 * string. Empty for GIF, redacted, media and not-yet-decrypted messages.
 */
export function extractPreviewUrls(source: PreviewSource | string, opts: ExtractOptions = {}): string[] {
  const max = Math.max(0, Math.floor(opts.max ?? PREVIEW_MAX_LINKS));
  if (max === 0) return [];
  const body: PreviewSource = typeof source === 'string' ? { text: source } : source;
  if (body.isRedacted || body.gif) return [];
  if (body.decryption && body.decryption.status !== 'decrypted') return [];
  if (body.msgtype !== undefined && !PROSE_MSGTYPES.has(body.msgtype)) return [];
  const candidates = typeof body.html === 'string' && body.html ? candidatesFromHtml(body.html) : candidatesFromText(body.text ?? '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const url = normalizePreviewUrl(c, opts);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
