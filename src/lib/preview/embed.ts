/**
 * Click-to-play embeds parsed from the URL alone (Phase 6, brief decision 5): YouTube and Spotify. Pure module.
 * Nothing here touches the network; the component creates the iframe only after the viewer clicks play.
 *
 *   parseEmbed('https://youtu.be/dQw4w9WgXcQ?t=43')
 *   // { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', startSeconds: 43,
 *   //   embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=43', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
 *   parseEmbed('https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x')
 *   // { provider: 'spotify', kind: 'track', id: '4cOdK2wGLETKBW3PvgPWqT',
 *   //   embedUrl: 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT', canonicalUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT' }
 */
import type { LinkEmbed } from './types.ts';

export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
export const SPOTIFY_EMBED_ORIGIN = 'https://open.spotify.com';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_KINDS = new Set(['track', 'album', 'playlist', 'episode']);

/** "1h2m3s" | "90s" | "90" -> seconds; null when unparseable or zero. */
function parseYoutubeTime(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) > 0 ? Number(raw) : null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return secs > 0 ? secs : null;
}

function youtube(u: URL): LinkEmbed | null {
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  const segments = u.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') {
    id = segments[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') id = u.searchParams.get('v');
    else if ((segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live' || segments[0] === 'v') && segments[1]) id = segments[1];
  }
  if (!id || !YOUTUBE_ID_RE.test(id)) return null;
  const start = parseYoutubeTime(u.searchParams.get('t') ?? u.searchParams.get('start'));
  const embed: LinkEmbed = {
    provider: 'youtube',
    kind: 'video',
    id,
    embedUrl: `${YOUTUBE_EMBED_ORIGIN}/embed/${id}${start ? `?start=${start}` : ''}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
  };
  if (start) embed.startSeconds = start;
  return embed;
}

function spotify(u: URL): LinkEmbed | null {
  if (u.hostname.toLowerCase() !== 'open.spotify.com') return null;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments[0] && /^intl-[a-z]{2,3}$/i.test(segments[0])) segments.shift();
  if (segments[0] === 'embed') segments.shift();
  const [kind, id] = segments;
  if (!kind || !id || !SPOTIFY_KINDS.has(kind) || !SPOTIFY_ID_RE.test(id)) return null;
  return {
    provider: 'spotify',
    kind: kind as LinkEmbed['kind'],
    id,
    embedUrl: `${SPOTIFY_EMBED_ORIGIN}/embed/${kind}/${id}`,
    canonicalUrl: `${SPOTIFY_EMBED_ORIGIN}/${kind}/${id}`,
  };
}

/** A YouTube or Spotify embed for the URL, or null for everything else (including unparseable strings). */
export function parseEmbed(url: string): LinkEmbed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return youtube(u) ?? spotify(u);
}

/** True when `parseEmbed(url) !== null`. */
export function isEmbedUrl(url: string): boolean {
  return parseEmbed(url) !== null;
}
