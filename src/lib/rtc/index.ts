/**
 * Phase 7 (voice calls): the call layer, `import from '@/lib/rtc'`. Features use the store (`@/store` ->
 * `useCallStore` + hooks); this barrel is for the pure helpers Dev A / Dev B render with and for scripts/tests.
 */
export { CallError } from './types.ts';
export type {
  CallAvailability,
  CallDirection,
  CallEndReason,
  CallErrorCode,
  CallHistoryEntry,
  CallOutcome,
  CallParticipant,
  CallStateName,
  IncomingCall,
  LivekitFocus,
} from './types.ts';
export { CallSession, RING_TIMEOUT_MS, type CallSessionSnapshot } from './session.ts';
export { describeCallEvent, formatCallDuration, isCallEvent, isCallTimelineEvent, CALL_NOTIFICATION_TYPE, CALL_DECLINE_TYPE, CALL_MEMBER_TYPE, CALL_SLOT_TYPE, type CallEventRow } from './timeline.ts';
export { discoverFocus, setFocusOverride, parseFociFromWellKnown, parseFociFromTransports, RTC_FOCUS_STORAGE_KEY } from './focus.ts';
export { fetchSfuToken } from './token.ts';
export { mergeParticipants, otherUserIds, identityOf, parseIdentity } from './participants.ts';
export { CALL_POWER_LEVELS, canSendCallState, ensureCallPowerLevels, missingCallPowerLevels } from './permissions.ts';
export { sendDecline, watchIncomingCalls, evaluateRing, parseRingContent, ringExpiry, buildDeclineContent, buildRingContent, type RingStopReason, type RingRejection } from './ringing.ts';
export { CALL_KEYS_TIMEOUT_MS, DELAYED_LEAVE_MS } from './constants.ts';
export { mediaEncryptionSupported } from './e2ee-worker.ts';
export { outcomeOf, makeHistoryEntry, appendHistory } from './history.ts';
// Wave 2: the Codec chat-line event, the ring / bridge policy helpers.
export {
  CALL_LINE_TYPE,
  getCallLine,
  formatCallLine,
  formatCallLineDuration,
  callLinePreviewText,
  isMissedForViewer,
  buildCallLineContent,
  isCallOpeningMembership,
  setCallTimelineResolver,
  type CallLine,
  type CallLineKind,
} from './lines.ts';
export {
  CALL_RING_MAX_MEMBERS,
  BRIDGE_STATE_TYPES,
  DEFAULT_GHOST_PREFIXES,
  ringPolicy as ringPolicyFor,
  ringTargets,
  isBridgedRoom,
  isBridgeGhost,
  bridgeGhostPrefixes,
  bridgeGhostOnly,
  hasBridgeGhost,
  splitMembers,
  type RingPolicy,
} from './policy.ts';
