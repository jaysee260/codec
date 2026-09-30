/**
 * Emoji picker popover (DEV-B-5). Six hardcoded keys, matching the seed's reaction keys.
 * Rendered in a portal so the message list's `overflow: auto` cannot clip it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ReactionPicker.module.css';

export const REACTION_KEYS: readonly string[] = ['👍', '❤️', '😂', '🎉', '🔥', '👀'];

const WIDTH = 244;
const HEIGHT = 48;

export function ReactionPicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  onPick(key: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const top = rect.top - HEIGHT - 8 < 8 ? rect.bottom + 8 : rect.top - HEIGHT - 8;
    const left = Math.max(8, Math.min(rect.left - WIDTH / 2 + rect.width / 2, window.innerWidth - WIDTH - 8));
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={styles.picker}
      data-testid="reaction-picker"
      role="menu"
      aria-label="Add a reaction"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: WIDTH }}
    >
      {REACTION_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className={styles.option}
          data-testid={`reaction-picker-${key}`}
          title={`React with ${key}`}
          onClick={() => onPick(key)}
        >
          {key}
        </button>
      ))}
    </div>,
    document.body,
  );
}
