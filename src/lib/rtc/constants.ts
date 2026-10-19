/**
 * Phase 7: timing constants of the call layer (pure; Node-loadable, shared by the session, the ring watcher and tests).
 */
/** How long a DM ring waits for an answer (PLAN: 60 s, then "missed"). */
export const RING_TIMEOUT_MS = 60_000;
/** The server sends our leave this long after the last keep-alive (the SDK restarts it every few seconds). */
export const DELAYED_LEAVE_MS = 8_000;
/** Time to wait for the leave state event before giving up on the network. */
export const LEAVE_TIMEOUT_MS = 5_000;
/** A connected participant without a media key after this long is reported as `keyState: 'missing'`. */
export const CALL_KEYS_TIMEOUT_MS = 5_000;
