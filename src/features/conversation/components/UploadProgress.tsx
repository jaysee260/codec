/**
 * Upload indicator (DEV-B-8). `uploadFile` gives no progress events, so the bar is indeterminate;
 * it disappears when the `m.image` / `m.file` event has been sent.
 */
import { Image as ImageIcon } from 'lucide-react';
import styles from './UploadProgress.module.css';

export function UploadProgress({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const label = names.length === 1 ? names[0] : `${names.length} files`;
  return (
    <div className={styles.progress} data-testid="upload-progress" role="status">
      <ImageIcon size={16} className={styles.icon} aria-hidden="true" />
      <span className={`${styles.name} u-truncate`}>Uploading {label}...</span>
      <span className={styles.bar}>
        <span className={styles.fill} />
      </span>
    </div>
  );
}
