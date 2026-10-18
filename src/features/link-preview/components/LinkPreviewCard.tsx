/**
 * One link preview card (DEV-A-30) for one URL of one message. Dev B maps URLs to cards inside its own
 * `link-previews` host; this component renders no host of its own.
 *
 *   import { LinkPreviewCard } from '@/features/link-preview';
 *   <LinkPreviewCard key={url} eventId={event.getId()!} url={url} auto={shouldAutoPreview(roomId, event)} ts={event.getTs()} />
 *
 * Props (docs/PHASE6_TICKETS.md "Shared API"):
 *   eventId   the message's event id (hide key is `eventId|url`)
 *   url       one URL exactly as `extractPreviewUrls` / `getPreviewUrls` returned it (normalised, hash stripped)
 *   auto      true = plain room: fetch on mount. false = encrypted room: render "Show preview" and fetch only
 *             after that click (asking the homeserver reveals the URL, brief decision 2)
 *   ts        the event timestamp, passed to the server's `ts` parameter
 *   onHidden  called with `url` right after the viewer hides the card (optional; the card also returns null)
 *   onEmpty   called once with `url` when an auto (plain-room) card resolves to empty / failed and renders nothing
 *             (optional; never called when auto=false, where "No preview available" is shown instead)
 *
 * `link-preview[data-state]`:
 *   click-to-load  (auto=false, not clicked, nothing cached) `link-preview-load` + `link-preview-hide`
 *   loading        one-line placeholder (never taller than a text line)
 *   ready          the card: `link-preview-site`, `-title`, `-description`, `-image`, `-hide`, and for YouTube /
 *                  Spotify `-play` -> `-embed` (EmbedPlayer; no third-party request before the click)
 *   unavailable    (auto=false only) `link-preview-unavailable` + `link-preview-hide`
 * Renders null when hidden (`useHiddenPreview`) or when a plain-room preview is `empty`.
 *
 * og data is untrusted: every string is rendered as React text (never HTML), the image goes through
 * `mxcToHttp` only (a non-mxc image is dropped), and the link target must be http(s).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { mxcToHttp } from '@/lib/matrix/utils.ts';
import { parseEmbed, previewImageLayout, useHiddenPreview, useLinkPreview, type LinkEmbed, type LinkPreview } from '@/lib/preview';
import { useIsPhone } from '@/store/layout.ts';
import { EmbedFrame, EmbedPlayer } from './EmbedPlayer.tsx';
import styles from './LinkPreviewCard.module.css';

export interface LinkPreviewCardProps {
  eventId: string;
  url: string;
  auto: boolean;
  ts?: number;
  onHidden?: (url: string) => void;
  onEmpty?: (url: string) => void;
}

/** Large image box limits (CSS px). The card itself is at most 480 px wide on desktop. */
export const LARGE_MAX_W = 400;
export const LARGE_MAX_H = 300;
/** Thumbnail box (CSS px), square, beside the text. */
export const THUMB_SIZE = 72;

type CardState = 'click-to-load' | 'loading' | 'ready' | 'unavailable';

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dpr(): number {
  const r = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return Math.min(3, Math.max(1, r || 1));
}

/** Large box: the image's aspect ratio, at most 400 x 300 and never upscaled. */
function largeBox(width: number, height: number): { maxWidth: number; ratio: string } {
  const maxWidth = Math.max(1, Math.floor(Math.min(LARGE_MAX_W, width, (LARGE_MAX_H * width) / height)));
  return { maxWidth, ratio: `${width} / ${height}` };
}

export function LinkPreviewCard({ eventId, url, auto, ts, onHidden, onEmpty }: LinkPreviewCardProps) {
  const [clicked, setClicked] = useState(false);
  const { status, preview } = useLinkPreview(url, { enabled: auto || clicked, ts });
  const { hidden, hide } = useHiddenPreview(eventId, url);
  const isPhone = useIsPhone();
  const embed = parseEmbed(url);
  const isAutoEmpty = auto && status === 'empty';
  const emptyReported = useRef<string | null>(null);
  const onEmptyRef = useRef(onEmpty);
  onEmptyRef.current = onEmpty;
  useEffect(() => {
    if (!isAutoEmpty || emptyReported.current === url) return;
    emptyReported.current = url;
    onEmptyRef.current?.(url);
  }, [isAutoEmpty, url]);

  if (hidden) return null;

  const state: CardState | null =
    status === 'ready' && preview
      ? 'ready'
      : status === 'loading'
        ? 'loading'
        : status === 'idle'
          ? 'click-to-load'
          : auto
            ? null // plain room, empty / failed: errors stay quiet
            : 'unavailable';
  if (state === null) return null;

  const onHide = () => {
    hide();
    onHidden?.(url);
  };
  const host = hostnameOf(url);
  const common = {
    'data-testid': 'link-preview',
    'data-url': url,
    'data-state': state,
    'data-embed': embed?.provider,
    'data-phone': isPhone ? 'true' : undefined,
  };
  const hideButton = (
    <button type="button" className={styles.hide} data-testid="link-preview-hide" aria-label="Hide preview" title="Hide preview" onClick={onHide}>
      <X size={16} aria-hidden="true" />
    </button>
  );

  if (state === 'loading') {
    return (
      <div {...common} className={`${styles.card} ${styles.placeholder}`} aria-busy="true" aria-label={`Loading preview for ${host}`}>
        <span className={styles.skeleton} />
      </div>
    );
  }

  if (state === 'click-to-load') {
    return (
      <div {...common} className={`${styles.card} ${styles.compact}`}>
        <button type="button" className={styles.load} data-testid="link-preview-load" onClick={() => setClicked(true)}>
          <span className={styles.loadLabel}>Show preview</span>
          <span className={styles.loadHost}>{host}</span>
        </button>
        {hideButton}
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <div {...common} className={`${styles.card} ${styles.compact}`}>
        <span className={styles.unavailable} data-testid="link-preview-unavailable">
          No preview available
        </span>
        {hideButton}
      </div>
    );
  }

  return <ReadyCard common={common} preview={preview!} url={url} host={host} embed={embed} hideButton={hideButton} />;
}

function ReadyCard({
  common,
  preview,
  url,
  host,
  embed,
  hideButton,
}: {
  common: Record<string, string | undefined>;
  preview: LinkPreview;
  url: string;
  host: string;
  embed: LinkEmbed | null;
  hideButton: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const image = preview.image;
  const rawLayout = previewImageLayout(image);
  const layout = rawLayout === 'none' ? 'text' : rawLayout;
  const href = safeHref(preview.url || url);
  const scale = dpr();

  let imageSrc = '';
  let large: { maxWidth: number; ratio: string } | null = null;
  if (image && layout === 'large' && image.width && image.height) {
    large = largeBox(image.width, image.height);
    const w = large.maxWidth;
    imageSrc = mxcToHttp(image.mxc, Math.round(w * scale), Math.round(((w * image.height) / image.width) * scale), 'scale');
  } else if (image && layout === 'thumbnail') {
    imageSrc = mxcToHttp(image.mxc, Math.round(THUMB_SIZE * scale), Math.round(THUMB_SIZE * scale), 'crop');
  }
  const showImage = !!imageSrc && !imageFailed;
  const alt = preview.title ? `Preview image: ${preview.title}` : '';

  const imgEl = (size: 'large' | 'thumbnail') =>
    showImage ? (
      <img
        data-testid="link-preview-image"
        data-size={size}
        className={styles.image}
        src={imageSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setImageFailed(true)}
      />
    ) : null;

  const thumbBox =
    layout === 'thumbnail' && showImage && !playing ? (
      <div className={styles.thumbBox} style={{ width: THUMB_SIZE, height: THUMB_SIZE }}>
        {embed ? <EmbedPlayer embed={embed} poster={imgEl('thumbnail')} playing={false} onPlay={() => setPlaying(true)} /> : imgEl('thumbnail')}
      </div>
    ) : null;

  const largeBoxEl =
    large && showImage && !playing ? (
      <div className={styles.largeBox} style={{ maxWidth: large.maxWidth, aspectRatio: large.ratio }}>
        {embed ? <EmbedPlayer embed={embed} poster={imgEl('large')} playing={false} onPlay={() => setPlaying(true)} /> : imgEl('large')}
      </div>
    ) : null;

  // An embed whose card has no usable image still gets a play button, in place of the image.
  const inlinePlay = embed && !playing && !thumbBox && !largeBoxEl ? <EmbedPlayer embed={embed} variant="inline" playing={false} onPlay={() => setPlaying(true)} /> : null;

  return (
    <div {...common} data-layout={layout} className={styles.card}>
      <div className={styles.content}>
        <div className={styles.header}>
          <div className={styles.text}>
            <div className={styles.site} data-testid="link-preview-site">
              {preview.siteName || host}
            </div>
            <a className={styles.title} data-testid="link-preview-title" href={href} target="_blank" rel="noopener noreferrer">
              {preview.title || host}
            </a>
            {preview.description ? (
              <div className={styles.description} data-testid="link-preview-description">
                {preview.description}
              </div>
            ) : null}
          </div>
          {thumbBox}
        </div>
        {largeBoxEl}
        {inlinePlay}
        {embed && playing ? <EmbedFrame embed={embed} /> : null}
      </div>
      {hideButton}
    </div>
  );
}
