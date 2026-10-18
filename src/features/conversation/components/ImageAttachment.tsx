/**
 * Media rows (DEV-B-4): `m.image` thumbnails and `m.file` download links.
 *
 * The thumbnail comes from `mxcToHttp(url, 400, 300, 'scale')` and gets explicit width/height from
 * `info.w/h` so the timeline does not jump while images decode. Clicking opens the full-size media.
 *
 * Phase 5 (DEV-B-28): encrypted media (`body.file`, no `url`) never touches a server thumbnail or the raw
 * mxc URL (that is ciphertext). The image is downloaded and decrypted (`useDecryptedMediaUrl`, i.e.
 * `fetchDecryptedMedia`, which verifies the SHA-256 first) only once the row has come near the viewport
 * (AC-E3-6), into a placeholder of exactly the fitted `info.w/h` box so nothing moves when it lands:
 *
 *   message-image[data-encrypted="true"][data-state="loading"]   the sized placeholder (a div)
 *   message-image[data-encrypted="true"][data-state="ready"]     the `<img src="blob:...">` itself, like plain rooms
 *   message-image[data-encrypted="true"][data-state="error"]     `message-image-error` + `message-image-retry`
 *
 * Opening and downloading go through `openMedia` / `downloadMedia` with the `EncryptedFile` source, which
 * decrypt first. The blob URL is cached per attachment for the session (ARCHITECTURE "Attachments": never
 * revoke it yourself), so rows do **not** release it on unmount: the same image can be mounted twice
 * (thread root + channel row) and a release in one would blank the other.
 */
import { useRef, useState } from 'react';
import { Download, FileText, ImageOff, Lock, RotateCw } from 'lucide-react';
import { mxcToHttp, type EncryptedFile } from '@/lib/matrix/utils.ts';
import { downloadMedia, openMedia } from '@/lib/matrix/media.ts';
import type { DisplayBody } from '@/lib/matrix/utils.ts';
import { useDecryptedMediaUrl } from '@/store/hooks.ts';
import { useInViewOnce } from '../hooks/useInView.ts';
import styles from './ImageAttachment.module.css';

const MAX_W = 400;
const MAX_H = 300;

/**
 * Scale `w x h` into the 400 x 300 media box, never upscaling. Shared with `GifMessage` (Phase 4) so an
 * inline GIF and an `m.image` thumbnail of the same dimensions occupy exactly the same space.
 */
export function fitted(w: number | undefined, h: number | undefined): { width: number; height: number } {
  if (!w || !h) return { width: MAX_W, height: Math.round((MAX_W * 3) / 4) };
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function ImageAttachment({ body }: { body: DisplayBody }) {
  if (body.file) return <EncryptedImage body={body} file={body.file} />;
  if (!body.url) return <div className={styles.missing}>Image unavailable</div>;
  const { width, height } = fitted(body.info?.w, body.info?.h);
  const full = mxcToHttp(body.url);
  return (
    <a
      className={styles.imageLink}
      href={full}
      onClick={(e) => openMedia(e, full, body.text || undefined)}
      target="_blank"
      rel="noopener noreferrer"
      title={body.text || 'Open image'}
      style={{ width, maxWidth: '100%' }}
    >
      <img
        className={styles.image}
        data-testid="message-image"
        src={mxcToHttp(body.url, MAX_W, MAX_H, 'scale')}
        alt={body.text || 'image'}
        width={width}
        height={height}
        loading="lazy"
      />
    </a>
  );
}

/** One decryption attempt; remounted (new `key`) by the retry button so the hook fetches again. */
function EncryptedImageAttempt({
  body,
  file,
  enabled,
  width,
  height,
  onRetry,
}: {
  body: DisplayBody;
  file: EncryptedFile;
  enabled: boolean;
  width: number;
  height: number;
  onRetry(): void;
}) {
  const mimetype = body.info?.mimetype;
  const media = useDecryptedMediaUrl(enabled ? file : null, mimetype);
  const name = body.text || undefined;
  const ratio = body.info?.w && body.info?.h ? `${body.info.w} / ${body.info.h}` : `${width} / ${height}`;

  if (media.url) {
    return (
      <a
        className={styles.imageLink}
        href={media.url}
        onClick={(e) => openMedia(e, file, name, mimetype)}
        target="_blank"
        rel="noopener noreferrer"
        title={body.text || 'Open image'}
        style={{ width, maxWidth: '100%' }}
      >
        <img
          className={styles.image}
          data-testid="message-image"
          data-encrypted="true"
          data-state="ready"
          src={media.url}
          alt={body.text || 'image'}
          width={width}
          height={height}
        />
      </a>
    );
  }

  const failed = !!media.error;
  // The error text and retry need room even for a tiny image; the row may grow then (it is terminal).
  return (
    <div className={styles.imageLink} style={{ width: failed ? Math.max(width, 220) : width, maxWidth: '100%' }}>
      <div
        className={`${styles.placeholder} ${failed ? styles.placeholderError : ''}`}
        data-testid="message-image"
        data-encrypted="true"
        data-state={failed ? 'error' : 'loading'}
        style={{ aspectRatio: ratio }}
        title={failed ? media.error ?? undefined : body.text || undefined}
        aria-busy={failed ? undefined : true}
      >
        {failed ? (
          <div className={styles.imageError} data-testid="message-image-error" role="alert">
            <ImageOff size={20} aria-hidden="true" />
            <span>Could not decrypt image</span>
            <button type="button" className={styles.retry} data-testid="message-image-retry" onClick={onRetry}>
              <RotateCw size={13} aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : (
          <Lock size={18} className={styles.placeholderIcon} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function EncryptedImage({ body, file }: { body: DisplayBody; file: EncryptedFile }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const seen = useInViewOnce(boxRef);
  const [attempt, setAttempt] = useState(0);
  const { width, height } = fitted(body.info?.w, body.info?.h);
  return (
    <div ref={boxRef} className={styles.encryptedBox}>
      <EncryptedImageAttempt
        key={attempt}
        body={body}
        file={file}
        enabled={seen}
        width={width}
        height={height}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    </div>
  );
}

function humanSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileAttachment({ body }: { body: DisplayBody }) {
  if (body.file) return <EncryptedFileAttachment body={body} file={body.file} />;
  if (!body.url) return <div className={styles.missing}>File unavailable</div>;
  const size = humanSize(body.info?.size);
  const href = mxcToHttp(body.url);
  return (
    <a
      className={styles.file}
      data-testid="message-file"
      href={href}
      onClick={(e) => downloadMedia(e, href, body.text || undefined)}
      target="_blank"
      rel="noopener noreferrer"
      download={body.text || undefined}
    >
      <FileText size={28} className={styles.fileIcon} aria-hidden="true" />
      <span className={styles.fileMeta}>
        <span className={`${styles.fileName} u-truncate`}>{body.text || 'file'}</span>
        {size && <span className={styles.fileSize}>{size}</span>}
      </span>
      <Download size={18} className={styles.fileDownload} aria-hidden="true" />
    </a>
  );
}

/**
 * Encrypted `m.file` (AC-E3-3): a button, not a link - there is no URL to point at (the mxc is ciphertext).
 * `downloadMedia` fetches, verifies, decrypts and saves under the event's file name.
 */
function EncryptedFileAttachment({ body, file }: { body: DisplayBody; file: EncryptedFile }) {
  const size = humanSize(body.info?.size);
  const name = body.text || 'file';
  return (
    <button
      type="button"
      className={`${styles.file} ${styles.fileButton}`}
      data-testid="message-file"
      data-encrypted="true"
      title={`Download ${name}`}
      onClick={(e) => downloadMedia(e, file, name, body.info?.mimetype)}
    >
      <FileText size={28} className={styles.fileIcon} aria-hidden="true" />
      <span className={styles.fileMeta}>
        <span className={`${styles.fileName} u-truncate`}>{name}</span>
        {size && <span className={styles.fileSize}>{size}</span>}
      </span>
      <Download size={18} className={styles.fileDownload} aria-hidden="true" />
    </button>
  );
}
