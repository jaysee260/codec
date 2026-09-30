/**
 * Placeholder Composer (Dev B replaces the internals). Enter sends, Shift+Enter newline,
 * paperclip uploads, typing notifications throttled.
 * testids: composer, composer-input, composer-send, composer-attach, composer-file-input
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Paperclip, SendHorizontal } from 'lucide-react';
import { sendFile, sendText, sendTyping } from '@/lib/matrix/actions.ts';
import { useRoomSummary } from '@/store/hooks.ts';
import { withToast } from '@/store/toast.ts';
import styles from './Composer.module.css';

const TYPING_THROTTLE_MS = 4000;

export function Composer({ roomId }: { roomId: string }) {
  const room = useRoomSummary(roomId);
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setText('');
    inputRef.current?.focus();
  }, [roomId]);

  const stopTyping = (): void => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (lastTypingSent.current) {
      lastTypingSent.current = 0;
      void sendTyping(roomId, false).catch(() => undefined);
    }
  };

  const noteTyping = (): void => {
    const now = Date.now();
    if (now - lastTypingSent.current > TYPING_THROTTLE_MS) {
      lastTypingSent.current = now;
      void sendTyping(roomId, true, TYPING_THROTTLE_MS + 2000).catch(() => undefined);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 5000);
  };

  const submit = (): void => {
    const body = text.trim();
    if (!body) return;
    setText('');
    stopTyping();
    void withToast(() => sendText(roomId, body), 'Send failed');
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    void withToast(() => sendFile(roomId, file), 'Upload failed').finally(() => setUploading(false));
  };

  const placeholder = room ? (room.isDm ? `Message @${room.name}` : `Message #${room.name}`) : 'Message';

  return (
    <div className={styles.composer} data-testid="composer">
      <div className={styles.box}>
        <button className={styles.attach} data-testid="composer-attach" title="Upload a file" disabled={uploading} onClick={() => fileRef.current?.click()}>
          <Paperclip size={20} />
        </button>
        <input ref={fileRef} type="file" className={styles.fileInput} data-testid="composer-file-input" onChange={onFile} />
        <textarea
          ref={inputRef}
          className={styles.input}
          data-testid="composer-input"
          placeholder={placeholder}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim()) noteTyping();
          }}
          onKeyDown={onKeyDown}
          onBlur={stopTyping}
        />
        <button className={styles.send} data-testid="composer-send" title="Send" disabled={!text.trim()} onClick={submit}>
          <SendHorizontal size={20} />
        </button>
      </div>
      {uploading && (
        <div className={styles.progress} data-testid="upload-progress">
          Uploading...
        </div>
      )}
    </div>
  );
}
