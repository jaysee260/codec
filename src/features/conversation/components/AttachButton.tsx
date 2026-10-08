/** Composer attach button + hidden file input (DEV-B-8). `tid` prefixes the ids inside the thread panel. */
import { useRef } from 'react';
import { Plus } from 'lucide-react';
import { plainTid, type Tid } from '../tid.ts';
import styles from './AttachButton.module.css';

export function AttachButton({
  disabled,
  tid = plainTid,
  onFiles,
}: {
  disabled?: boolean;
  tid?: Tid;
  onFiles(files: File[]): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={styles.attach}
        data-testid={tid('composer-attach')}
        title="Upload a file"
        aria-label="Upload a file"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Plus size={20} />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className={styles.input}
        data-testid={tid('composer-file-input')}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
