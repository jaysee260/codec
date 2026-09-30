/**
 * Pure formatting helpers shared by every feature. No SDK or store imports here
 * (only the pure mxc helper), so these are trivially unit-testable.
 */
import DOMPurify from 'dompurify';
import { mxcToHttp } from './matrix/mxc.ts';

// ---------------------------------------------------------------------------
// HTML sanitising (Matrix spec allowlist for org.matrix.custom.html)
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = [
  'font', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol', 'sup', 'sub', 'li',
  'b', 'i', 'u', 'strong', 'em', 's', 'code', 'hr', 'br', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'caption', 'pre', 'span', 'img', 'details', 'summary',
];
const ALLOWED_ATTR = [
  'href', 'name', 'target', 'rel', 'class', 'src', 'width', 'height', 'alt', 'title', 'start', 'colspan',
  'rowspan', 'data-mx-color', 'data-mx-bg-color', 'data-mx-spoiler', 'data-mx-maths',
];
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|matrix|mxc|magnet):|#)/i;

let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      // Only mxc images are allowed by the spec; rewrite them to a bounded thumbnail URL.
      const src = el.getAttribute('src') ?? '';
      if (src.startsWith('mxc://')) el.setAttribute('src', mxcToHttp(src, 800, 600, 'scale'));
      else el.removeAttribute('src');
    }
    if (el.tagName === 'CODE') {
      const cls = el.getAttribute('class') ?? '';
      const lang = cls.split(/\s+/).find((c) => c.startsWith('language-'));
      if (lang) el.setAttribute('class', lang);
      else el.removeAttribute('class');
    } else if (el.hasAttribute('class')) {
      el.removeAttribute('class');
    }
  });
}

/**
 * Sanitise a Matrix `formatted_body` for `dangerouslySetInnerHTML`.
 * Anchors get target=_blank + rel=noopener noreferrer; <img> only keeps mxc sources (rewritten to http).
 */
export function sanitizeHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
    KEEP_CONTENT: true,
  });
}

// ---------------------------------------------------------------------------
// Plain text helpers
// ---------------------------------------------------------------------------

export type TextSegment = { kind: 'text'; value: string } | { kind: 'link'; value: string; href: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Split plain text into text/link segments. Trailing punctuation is left out of the link. */
export function linkify(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const url = match[0].replace(/[.,;:!?)\]]+$/, '');
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) });
    out.push({ kind: 'link', value: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0');

export function isSameDay(a: number | Date, b: number | Date): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** `HH:MM` for today, `DD/MM/YYYY HH:MM` otherwise (AC-B1-8). */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (isSameDay(d, Date.now())) return hm;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hm}`;
}

/** Full timestamp for tooltips, e.g. "Tuesday, 30 September 2026 14:05". */
export function formatFullTime(ts: number): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Today", "Yesterday" or "30 September 2026" for day dividers. */
export function formatDayDivider(ts: number): string {
  const now = Date.now();
  if (isSameDay(ts, now)) return 'Today';
  if (isSameDay(ts, now - 86_400_000)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Names / avatars
// ---------------------------------------------------------------------------

/** "Alice Park" -> "AP", "general" -> "G". */
export function initialsOf(name: string): string {
  const words = name.replace(/^[#@!]/, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[words.length - 1]!.slice(0, 1)).toUpperCase();
}

const AVATAR_COLORS = ['#5865f2', '#23a559', '#f0b232', '#eb459e', '#f23f43', '#00a8fc', '#9b59b6', '#e67e22'];

/** Deterministic colour for a user id or room id (Discord-like default avatar colours). */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}
