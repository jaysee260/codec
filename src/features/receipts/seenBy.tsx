/**
 * The single open Seen-by list (DEV-A-R3): state, the imperative API Dev B calls from the "Seen by" action, and
 * the host that renders it.
 *
 * The list is opened from places that unmount right after (the desktop hover toolbar, the phone action sheet),
 * so it cannot live inside its opener. Instead a host component is mounted once, on first open, into its own
 * React root on `document.body` (stores are zustand, so no context is needed). Exactly one `receipt-list`
 * exists at a time: opening another row's list replaces it.
 */
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { create } from 'zustand';
import { useSessionStore } from '@/store/session.ts';
import type { TimelineSource } from '@/store/timeline.ts';
import { SeenByList } from './components/SeenByList.tsx';
import type { OpenSeenByArgs, SeenByCloseReason, SeenByOpenMode } from './types.ts';

export interface OpenSeenBy {
  source: TimelineSource;
  eventId: string;
  trigger: HTMLElement | null;
  mode: SeenByOpenMode;
}

export interface SeenByState {
  open: OpenSeenBy | null;
}

export const useSeenByStore = create<SeenByState>(() => ({ open: null }));

/** The open list (or null). Components compare `eventId` / `source` to know whether it is theirs. */
export function useSeenByOpen(): OpenSeenBy | null {
  return useSeenByStore((s) => s.open);
}

/** True when `open` is the list of this source + event. */
export function isSameList(open: OpenSeenBy | null, source: TimelineSource, eventId: string): boolean {
  return (
    !!open &&
    open.eventId === eventId &&
    open.source.roomId === source.roomId &&
    (open.source.threadRootId ?? null) === (source.threadRootId ?? null)
  );
}

let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

function clearHoverClose(): void {
  if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
  hoverCloseTimer = null;
}

/**
 * Open the Seen-by list for one row. `mode: 'pinned'` (default) stays open until Escape / outside click / close
 * and moves focus into the list; `hover` closes again when the pointer leaves trigger and popover. Opening the
 * same list again with `pinned` pins a hover-opened one.
 */
export function openSeenBy({ source, eventId, trigger = null, mode = 'pinned' }: OpenSeenByArgs): void {
  clearHoverClose();
  const cur = useSeenByStore.getState().open;
  // Hover never demotes or replaces a pinned list (nor re-opens the one already showing).
  if (mode === 'hover' && cur && (cur.mode === 'pinned' || isSameList(cur, source, eventId))) return;
  ensureHost();
  useSeenByStore.setState({
    open: { source: { ...source }, eventId, trigger, mode },
  });
}

/**
 * Close the open list (if any). Focus goes back to the trigger when it was inside the list or the list was
 * pinned (keyboard / click users); a hover preview never moves focus.
 */
export function closeSeenBy(reason?: SeenByCloseReason): void {
  clearHoverClose();
  const cur = useSeenByStore.getState().open;
  if (!cur) return;
  const listEl = document.querySelector('[data-testid="receipt-list"]');
  const active = document.activeElement;
  const restore = reason !== 'outside' && (cur.mode === 'pinned' || (!!listEl && !!active && listEl.contains(active)));
  useSeenByStore.setState({ open: null });
  if (restore) restoreFocus(cur);
}

/** Pointer left the trigger or the popover: close a hover-opened list shortly after, unless it re-enters. */
export function scheduleHoverClose(delayMs = 180): void {
  clearHoverClose();
  if (useSeenByStore.getState().open?.mode !== 'hover') return;
  hoverCloseTimer = setTimeout(() => {
    hoverCloseTimer = null;
    if (useSeenByStore.getState().open?.mode === 'hover') closeSeenBy();
  }, delayMs);
}

/** Pointer is back over the trigger or the popover. */
export function cancelHoverClose(): void {
  clearHoverClose();
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

function restoreFocus(cur: OpenSeenBy): void {
  const target =
    (cur.trigger?.isConnected ? cur.trigger : null) ??
    document.querySelector<HTMLElement>(`[data-testid="receipt-avatars"][data-event-id="${cssEscape(cur.eventId)}"]`) ??
    document.querySelector<HTMLElement>(`[data-testid="message-${cssEscape(cur.eventId)}"]`);
  // Rows are not always focusable; focus() is then a no-op, which is fine.
  target?.focus({ preventScroll: true });
}

function SeenByHost() {
  const open = useSeenByOpen();
  const status = useSessionStore((s) => s.status);
  // Logout / session loss: drop the list (its room is gone).
  useEffect(() => {
    if (status !== 'ready' && useSeenByStore.getState().open) useSeenByStore.setState({ open: null });
  }, [status]);
  if (!open || status !== 'ready') return null;
  return (
    <SeenByList
      // A new row's list is a new dialog (fresh focus + position), not an update of the old one.
      key={`${open.source.roomId}|${open.source.threadRootId ?? ''}|${open.eventId}`}
      source={open.source}
      eventId={open.eventId}
      anchor={open.trigger}
      mode={open.mode}
      onClose={closeSeenBy}
      onPointerEnter={cancelHoverClose}
      onPointerLeave={() => scheduleHoverClose()}
    />
  );
}

let hostMounted = false;

function ensureHost(): void {
  if (hostMounted || typeof document === 'undefined') return;
  hostMounted = true;
  const el = document.createElement('div');
  el.setAttribute('data-receipts-host', '');
  document.body.appendChild(el);
  createRoot(el).render(<SeenByHost />);
}
