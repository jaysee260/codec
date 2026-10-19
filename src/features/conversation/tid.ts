/**
 * Test-id prefixing for the thread UI (Dev B, Phase 3).
 *
 * **Prefix rule** (docs/archive/PHASE3_ACCEPTANCE.md "Test ID registry"): the thread panel mounts a second
 * `MessageList` and a second `Composer` on the same page, so inside `thread-panel` every
 * `composer-*`, `message-list` and `timeline-*` id is renamed with a `thread-` prefix. Row-level ids
 * (`message-{eventId}`, `message-body`, `reaction-*`, `voice-message`, ...) deliberately stay exactly
 * as they are in Phase 1/2 - QA's row helpers are shared between the channel and the panel.
 * `typing-indicator` is the one id that is *renamed* rather than prefixed (`thread-typing`), so the
 * indicator takes an explicit id instead of a prefix.
 *
 * Everything goes through `makeTid(prefix)` so a component cannot accidentally prefix half of its ids.
 */

/** `tid('composer-input')` -> `'composer-input'` in a room, `'thread-composer-input'` in the panel. */
export type Tid = (name: string) => string;

/** Identity: the Phase 1/2 ids, unchanged. */
export const plainTid: Tid = (name) => name;

export function makeTid(prefix?: string): Tid {
  return prefix ? (name) => `${prefix}${name}` : plainTid;
}
