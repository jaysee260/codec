/**
 * Phase 7: call-history bookkeeping (pure, unit-tested). The store appends an entry whenever a call ends or an
 * incoming ring stops without being answered; Dev B renders "Call ended, 12 min" / "Missed call from JC, Call back".
 */
import type { CallDirection, CallEndReason, CallHistoryEntry, CallOutcome } from './types.ts';

export const HISTORY_STORAGE_KEY = 'matrix-poc.callHistory';
export const HISTORY_LIMIT = 200;

/** Outcome of an outgoing / joined call from how it ended and whether media ever connected. */
export function outcomeOf(reason: CallEndReason, connected: boolean): CallOutcome {
  switch (reason) {
    case 'declined':
      return 'declined';
    case 'busy':
      return 'busy';
    case 'no-answer':
      return 'no-answer';
    case 'answered-elsewhere':
      return 'cancelled';
    case 'error':
      return connected ? 'completed' : 'failed';
    case 'hangup':
    case 'remote-hangup':
      return connected ? 'completed' : 'cancelled';
  }
}

export function makeHistoryEntry(input: {
  roomId: string;
  direction: CallDirection;
  outcome: CallOutcome;
  peerUserId: string | null;
  startedAt: number;
  connectedAt: number | null;
  endedAt: number;
}): CallHistoryEntry {
  return {
    id: `${input.roomId}:${input.startedAt}:${input.direction}`,
    roomId: input.roomId,
    direction: input.direction,
    outcome: input.outcome,
    peerUserId: input.peerUserId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.connectedAt ? Math.max(0, input.endedAt - input.connectedAt) : 0,
  };
}

/** Newest first, capped; duplicates (same id) replaced. */
export function appendHistory(history: CallHistoryEntry[], entry: CallHistoryEntry): CallHistoryEntry[] {
  return [entry, ...history.filter((h) => h.id !== entry.id)].slice(0, HISTORY_LIMIT);
}

export function parseStoredHistory(raw: string | null): CallHistoryEntry[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (h): h is CallHistoryEntry =>
        !!h && typeof h === 'object' && typeof (h as CallHistoryEntry).roomId === 'string' && typeof (h as CallHistoryEntry).startedAt === 'number',
    );
  } catch {
    return [];
  }
}

/** A missed call is an incoming ring that ended unanswered on every device (not declined, not answered elsewhere). */
export function missedOutcome(reason: 'expired' | 'caller-left' | 'declined' | 'answered-elsewhere' | 'busy' | 'accepted'): CallOutcome | null {
  switch (reason) {
    case 'expired':
    case 'caller-left':
      return 'missed';
    case 'declined':
      return 'declined';
    case 'busy':
      return 'busy';
    case 'answered-elsewhere':
    case 'accepted':
      return null;
  }
}
