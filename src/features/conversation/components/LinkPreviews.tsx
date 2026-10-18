/**
 * Link preview cards under a message body (Phase 6, DEV-B-32 / DEV-B-33).
 *
 * `MessageRow` renders this right after `MessageBody` and before the reactions, both in a main timeline and in
 * the thread panel (replies and `thread-root`). Reply quotes, thread summaries, the Threads list and room
 * previews never render it, so they stay text only (AC-L7-1).
 *
 * - **Which links.** `getPreviewUrls(event)` (src/lib/preview): message order, deduped, at most 3; nothing for
 *   GIFs, media, redacted, undecryptable or still-decrypting events (AC-L1-5). Edits come for free: the SDK
 *   swaps `getContent()` to the replacement's `m.new_content`, so `getDisplayBody` already returns the edited
 *   text; the memo keys on that text, so the cards follow an edit (AC-L7-2) and appear when a late decryption
 *   turns a placeholder into text. Rows re-render on the timeline store's `version` bump (they are not
 *   memoised), so a fresh `body` always reaches this component.
 * - **When a request may be made.** `shouldAutoPreview(roomId, event)` is the one rule: false in encrypted rooms,
 *   where each card waits for its "Show preview" click (AC-L3-1). `useRoomEncrypted` subscribes to room changes
 *   so a room that turns encrypted flips new and existing rows to click-to-load.
 * - **Hidden cards** (the "x", per viewer) are filtered here as well as in the card, so `data-count` counts the
 *   visible cards and the host disappears when the last one is hidden (AC-L5-1).
 * - **Empty cards** (plain rooms: the preview resolved to nothing) report back through `onEmpty(url)` and are
 *   dropped the same way, so the host is not in the DOM when nothing is visible. The result is cached, so a
 *   remount reports again at once rather than refetching.
 *
 * Height changes from cards arriving (loading -> ready, image load) are absorbed by `MessageList`'s content
 * ResizeObserver: re-pinned to the bottom when stuck, the reader's row held still otherwise (DEV-B-34).
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import type { MatrixEvent } from 'matrix-js-sdk';
import { getPreviewUrls, hiddenPreviewsVersion, isPreviewHidden, shouldAutoPreview, subscribeHiddenPreviews } from '@/lib/preview';
import type { DisplayBody } from '@/lib/matrix/utils.ts';
import { useRoomEncrypted } from '@/store/hooks.ts';
import { LinkPreviewCard } from '@/features/link-preview';
import styles from './LinkPreviews.module.css';

export interface LinkPreviewsProps {
  roomId: string;
  event: MatrixEvent;
  /** `getDisplayBody(event)` from the row: its fields are the memo keys (edits, decryption, redaction). */
  body: DisplayBody;
}

export function LinkPreviews({ roomId, event, body }: LinkPreviewsProps) {
  const eventId = event.getId() ?? '';
  const urls = useMemo(
    () => getPreviewUrls(event),
    // `event` is mutated in place by the SDK (edits, decryption, redaction), so key on what it renders as.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event, body.text, body.html, body.msgtype, body.isRedacted, !!body.gif, body.decryption?.status],
  );
  const hiddenVersion = useSyncExternalStore(subscribeHiddenPreviews, hiddenPreviewsVersion, hiddenPreviewsVersion);
  const visible = useMemo(
    () => urls.filter((url) => !isPreviewHidden(eventId, url)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [urls, eventId, hiddenVersion],
  );
  // URLs whose card resolved empty. Entries for URLs no longer in `urls` are harmless (filtered against it).
  const [empty, setEmpty] = useState<ReadonlySet<string>>(() => new Set());
  const onEmpty = useCallback((url: string) => {
    setEmpty((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
  }, []);
  const shown = useMemo(() => visible.filter((url) => !empty.has(url)), [visible, empty]);
  const roomEncrypted = useRoomEncrypted(roomId);
  const auto = !roomEncrypted && shouldAutoPreview(roomId, event);

  if (shown.length === 0) return null;
  const ts = event.getTs();
  return (
    <div className={styles.host} data-testid="link-previews" data-count={shown.length}>
      {shown.map((url) => (
        <LinkPreviewCard key={url} eventId={eventId} url={url} auto={auto} ts={ts} onEmpty={onEmpty} />
      ))}
    </div>
  );
}
