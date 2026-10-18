/**
 * Click-to-play embed (DEV-A-31): YouTube (youtube-nocookie) and Spotify players behind a play button.
 *
 *   <EmbedPlayer embed={parseEmbed(url)!} poster={<img ... />} />            // uncontrolled
 *   <EmbedPlayer embed={embed} poster={...} playing={playing} onPlay={() => setPlaying(true)} />   // controlled
 *
 * Privacy rule (brief decision 5): no request to YouTube / Spotify before the click, ever. The poster is
 * whatever the caller passes (the card's own `og:image`, served through the homeserver via `mxcToHttp`);
 * this component never loads a provider thumbnail. The `<iframe>` only exists once `playing` is true.
 *
 * Test ids: `link-preview-play` (the button over the poster), `link-preview-embed` (the iframe).
 *
 * Box sizes (reserved, no jump when the player loads): YouTube 16:9, max 400 px wide; Spotify 152 px tall
 * for tracks / episodes, 352 px for albums / playlists, full width.
 */
import { useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import type { LinkEmbed } from '@/lib/preview';
import styles from './LinkPreviewCard.module.css';

export interface EmbedPlayerProps {
  embed: LinkEmbed;
  /** Rendered under the play button before the click (an `<img>` box the caller sized). Omit for a plain box. */
  poster?: ReactNode;
  /** Controlled mode: the caller owns the playing state. */
  playing?: boolean;
  onPlay?: () => void;
  /** `'overlay'` (default): the play button covers `poster`. `'inline'`: a compact button, for text-only cards. */
  variant?: 'overlay' | 'inline';
}

/** iframe src: the embed URL with autoplay on (the viewer already clicked play once). */
export function embedSrc(embed: LinkEmbed): string {
  if (embed.provider !== 'youtube') return embed.embedUrl;
  return `${embed.embedUrl}${embed.embedUrl.includes('?') ? '&' : '?'}autoplay=1`;
}

/** Player height in px for Spotify (fixed), or null for YouTube (16:9 box). */
export function spotifyHeight(embed: LinkEmbed): number | null {
  if (embed.provider !== 'spotify') return null;
  return embed.kind === 'album' || embed.kind === 'playlist' ? 352 : 152;
}

function providerName(embed: LinkEmbed): string {
  return embed.provider === 'youtube' ? 'YouTube' : 'Spotify';
}

/** The player iframe alone (created by the caller only after the click). */
export function EmbedFrame({ embed }: { embed: LinkEmbed }) {
  const h = spotifyHeight(embed);
  return (
    <div
      className={h === null ? styles.embedBoxVideo : styles.embedBoxAudio}
      style={h === null ? undefined : { height: h }}
      data-provider={embed.provider}
    >
      <iframe
        data-testid="link-preview-embed"
        className={styles.embedFrame}
        src={embedSrc(embed)}
        title={`${providerName(embed)} player`}
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    </div>
  );
}

export function EmbedPlayer({ embed, poster, playing, onPlay, variant = 'overlay' }: EmbedPlayerProps) {
  const [ownPlaying, setOwnPlaying] = useState(false);
  const isPlaying = playing ?? ownPlaying;
  if (isPlaying) return <EmbedFrame embed={embed} />;

  const play = () => {
    if (playing === undefined) setOwnPlaying(true);
    onPlay?.();
  };
  const label = `Play on ${providerName(embed)}`;

  if (variant === 'inline') {
    return (
      <button type="button" className={styles.playInline} data-testid="link-preview-play" aria-label={label} onClick={play}>
        <Play size={16} aria-hidden="true" fill="currentColor" />
        <span>Play</span>
      </button>
    );
  }
  return (
    <div className={styles.posterWrap}>
      {poster}
      <button type="button" className={styles.playOverlay} data-testid="link-preview-play" aria-label={label} onClick={play}>
        <span className={styles.playDisc}>
          <Play size={20} aria-hidden="true" fill="currentColor" />
        </span>
      </button>
    </div>
  );
}
