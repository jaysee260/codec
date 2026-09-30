/** Composer attach button + hidden file input (DEV-B-8). */
import { useRef } from 'react';
import { Plus } from 'lucide-react';
import styles from './AttachButton.module.css';

export function AttachButton({ disabled, onFiles }: { disabled?: boolean; onFiles(files: File[]): void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={styles.attach}
        data-testid="composer-attach"
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
        data-testid="composer-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
