/**
 * Media rows (DEV-B-4): `m.image` thumbnails and `m.file` download links.
 *
 * The thumbnail comes from `mxcToHttp(url, 400, 300, 'scale')` and gets explicit width/height from
 * `info.w/h` so the timeline does not jump while images decode. Clicking opens the full-size media.
 */
import { Download, FileText } from 'lucide-react';
import { mxcToHttp } from '@/lib/matrix/utils.ts';
import type { DisplayBody } from '@/lib/matrix/utils.ts';
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
  if (!body.url) return <div className={styles.missing}>Image unavailable</div>;
  const { width, height } = fitted(body.info?.w, body.info?.h);
  return (
    <a
      className={styles.imageLink}
      href={mxcToHttp(body.url)}
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

function humanSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileAttachment({ body }: { body: DisplayBody }) {
  if (!body.url) return <div className={styles.missing}>File unavailable</div>;
  const size = humanSize(body.info?.size);
  return (
    <a
      className={styles.file}
      data-testid="message-file"
      href={mxcToHttp(body.url)}
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
