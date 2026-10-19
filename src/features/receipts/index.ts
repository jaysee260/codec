/**
 * Read receipts UI (Dev A, DEV-A-R1..R4). Data comes from the core hooks in `@/store/hooks` (Principal); these
 * components only render it. Dev B wires them into MessageRow / MessageList / ThreadView / MessageActions:
 *
 *   import { SendStatus, ReadAvatars, openSeenBy } from '@/features/receipts';
 *
 *   // once per list (main or thread source):
 *   const { readPoints, latestOwnSentId } = useReadPointsResult(source, events);
 *
 *   // per row, both inside `message-{id}`:
 *   const status = useSendStatus(event);
 *   {status && (status !== 'sent' || id === latestOwnSentId) && (
 *     <SendStatus status={status}>{status === 'failed' ? existingFailedUi : null}</SendStatus>
 *   )}
 *   <ReadAvatars source={source} eventId={id} readers={readPoints.get(id)} />
 *
 *   // "Seen by" action (desktop toolbar button / phone action-sheet row; close the action sheet first):
 *   <button data-testid="message-action-seen-by" aria-label="Seen by"
 *           onClick={(e) => openSeenBy({ source, eventId: id, trigger: e.currentTarget })} />
 *
 * Props:
 * - `SendStatus({ status, children?, className? })` -> `receipt-status[data-status]`; null when `status` is null.
 *   `sending` hollow circle / `sent` check (aria-label + title "Sending…" / "Sent"); `failed` wraps `children`
 *   (the row's existing failed UI, its testids untouched) and shows a small alert icon only when no children.
 *   Inline, 16 px box, sits at the row's trailing edge (Dev B positions it).
 * - `ReadAvatars({ source, eventId, readers, className? })` -> `receipt-avatars[data-count][data-event-id]`;
 *   null when `readers` is empty/undefined (the row grows by the strip height when the first reader arrives).
 *   Fixed 22 px strip (44 px hit area on phone via negative margins, so layout height stays 22 px), right-aligned.
 *   `role="button"`, `aria-haspopup="dialog"`, `aria-expanded`, aria-label "Seen by …", `tabindex=0`.
 *   Owns its open state: hover (desktop) opens the list, click / tap / Enter / Space pins it.
 * - `openSeenBy({ source, eventId, trigger?, mode? })` / `closeSeenBy()` / `useSeenByOpen()`: the single list.
 *   The list renders in its own host mounted on `document.body` on first open (so it survives the toolbar or the
 *   action sheet unmounting); exactly one `receipt-list` at a time. Popover on desktop, bottom sheet on phone
 *   (`useIsPhone`). Escape / outside click / backdrop close it; focus returns to `trigger` (or the row's
 *   `receipt-avatars`, or the row) on close.
 * - `SeenByList({ source, eventId, anchor, onClose, mode? })`: the controlled list itself; normally you do not
 *   render it (use `openSeenBy`). Exported for harnesses.
 * - `ReadReceiptsToggle({ className? })` -> `settings-send-read-receipts`; mounted by Dev A in `UserFooter`.
 */
export { SendStatus } from './components/SendStatus.tsx';
export { ReadAvatars, ReaderAvatar } from './components/ReadAvatars.tsx';
export { seenByLabel, avatarStack, unseenCountLabel, MAX_SHOWN_AVATARS } from './labels.ts';
export { SeenByList } from './components/SeenByList.tsx';
export { ReadReceiptsToggle } from './components/ReadReceiptsToggle.tsx';
export { openSeenBy, closeSeenBy, useSeenByOpen, useSeenByStore, isSameList, type OpenSeenBy } from './seenBy.tsx';
export type {
  SendStatusProps,
  ReadAvatarsProps,
  SeenByListProps,
  OpenSeenByArgs,
  SeenByOpenMode,
  SeenByCloseReason,
} from './types.ts';
