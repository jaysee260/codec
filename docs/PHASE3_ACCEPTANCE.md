# Phase 3 Acceptance Criteria and Test ID Contract

Extends docs/ACCEPTANCE.md and docs/PHASE2_ACCEPTANCE.md (conventions, registries and criteria stay in force). Numbering `AC-T<group>-<n>`; each group names its tickets (docs/PHASE3_TICKETS.md). "desktop" = the `desktop` Playwright project, "phone" = the `mobile` project (Pixel 7), logged in as alice, **dirty seed always allowed**: every criterion creates its own root message (alice via the UI or bob via API) and never relies on seeded threads. "a thread reply via API" = QA's `sendThreadReply`, which sends the contract below as bob. Names in the Shared API are subject to the Principal's ARCHITECTURE deltas; the wire shapes here are not.

## Thread reply event (the contract Dev B, Principal and QA code against)
`sendText(roomId, body, { threadRoot })` sends exactly this `m.room.message` content (`sendFile` / `sendVoiceMessage` add the same `m.relates_to` to their content):

```json
{
  "msgtype": "m.text",
  "body": "Tacos work for me",
  "m.relates_to": {
    "rel_type": "m.thread",
    "event_id": "$root",
    "is_falling_back": true,
    "m.in_reply_to": { "event_id": "$latestReplyOrRoot" }
  }
}
```
Rules: `event_id` is the root (never a reply: threads do not nest); `m.in_reply_to.event_id` is the newest reply in the thread that already has a server id, else the root; `is_falling_back` is always `true` (a deliberate in-thread quote reply, `false`, is out of scope); no reply fallback text in `body`/`formatted_body`; `format`/`formatted_body`/`m.mentions` as for normal sends. **Reading**: any event with `m.relates_to.rel_type === 'm.thread'` is a thread reply, whatever `is_falling_back` says; `m.in_reply_to` with `is_falling_back: true` is **not** a quote. Edits of a reply are plain `m.replace` events whose `m.new_content` carries no `m.relates_to`. Reactions are `m.annotation` as today.

**Server summary** on a root (bundled by Synapse in `/sync`, `/messages`, `/threads`): `unsigned["m.relations"]["m.thread"] = { "count": 3, "current_user_participated": true, "latest_event": { ...event } }`.

**Receipts**: `POST /rooms/{roomId}/receipt/m.read/{eventId}` with body `{ "thread_id": "$root" }` for a thread reply and `{ "thread_id": "main" }` for a main-timeline event (the SDK adds it once `threadSupport` is on). Seen by bob in `/sync` ephemeral `m.receipt`: `content[$eventId]["m.read"]["@alice:localhost"] = { "ts": 1700000000000, "thread_id": "$root" }`.

**Endpoints QA reads**: `GET /_matrix/client/v1/rooms/{roomId}/threads?include=all` -> `{ chunk: [root events, newest activity first], next_batch? }`; `GET /_matrix/client/v1/rooms/{roomId}/relations/{rootId}/m.thread?dir=b&limit=50` -> `{ chunk, next_batch? }`.

## Test ID registry (additions)
Conventions as docs/ACCEPTANCE.md. **Prefix rule**: inside `thread-panel`, every `composer-*`, `message-list`, `timeline-*` and `typing-indicator` testid is renamed `thread-composer-*`, `thread-message-list`, `thread-timeline-*`, `thread-typing` (static ids stay unique per page). Rows inside the panel keep `message-{eventId}` and everything inside them (`message-actions`, `reaction-*`, `voice-message`, ...) as in Phase 1/2.

### Shell (Principal, `src/app/**`)
| testid | Element |
|---|---|
| `app-shell` (+`data-thread-open="true\|false"`) | Existing root; attribute follows `useThreadStore.open` |

### Navigation (Dev A, `src/features/navigation/**`)
| testid | Element |
|---|---|
| `header-threads` | Button in `channel-header`, left of `member-toggle`; channels and DMs; >= 44 px on phone |
| `header-threads-unread` | Dot on it while `threadUnreadByRoom[roomId]` is true |
| `thread-list` (+`data-variant="popover\|sheet"`) | Per-room list; popover anchored to the button on desktop, bottom sheet on phone |
| `thread-list-item-{rootId}` (+`data-count`, `data-ts`) | One item per thread, newest activity first |
| `thread-list-item-author`, `thread-list-item-snippet`, `thread-list-item-count`, `thread-list-item-time`, `thread-list-item-avatars` | Inside an item: root author, root `previewText` (<= 2 lines), `N replies`, relative time, up to 3 avatars |
| `thread-list-empty` | "No threads yet" |
| `thread-list-close` | Close button (sheet header / popover) |
| `header-back` | Phone-only; replaces `header-menu` while a thread is open; closes the thread. (Dropped in Phase 2 as a duplicate name, re-added here with this single meaning.) |
| `header-thread-room` | Room name under the `Thread` title on phone |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `thread-summary-{rootId}` (+`data-count`) | Row directly under `message-{rootId}`; only when count > 0; click opens the thread |
| `thread-summary-count`, `thread-summary-avatars`, `thread-summary-time` | `N replies` / `1 reply`; up to 3 participant avatars; relative time of the latest reply |
| `message-action-thread` | "Reply in thread" in `message-actions` (desktop) and `message-action-sheet` (phone); never rendered inside the panel |
| `thread-panel` (+`data-root="{rootId}"`) | Panel root (desktop right column, phone full-screen); mounted by the shell |
| `thread-root` | The root message at the top (its own testid, not `message-{rootId}`); its reactions/actions are scoped inside |
| `thread-replies-divider` | `No replies yet` / `N replies` |
| `thread-message-list`, `thread-timeline-start`, `thread-timeline-loading` | Replies scroll container, "beginning of thread", pagination spinner |
| `thread-typing` | Room typing indicator rendered in the panel |
| `thread-composer`, `thread-composer-input`, `thread-composer-send`, `thread-composer-attach`, `thread-composer-file-input`, `thread-composer-mic`, `thread-composer-recording`, `thread-composer-edit-banner`, `thread-composer-edit-cancel` | Composer inside the panel (prefix rule); placeholder `Replying in thread` |
| `thread-close` | Desktop-only close (X) |
| `thread-error` | Root could not be loaded / pagination failed |

## Criteria

### AC-T1 Thread support flip, hygiene and regression gate (PRIN-8, DEV-B-21; gate run by QA-17)
| ID | Given / When / Then |
|---|---|
| AC-T1-1 | Given `src/lib/matrix/client.ts`, then `startClient` passes `threadSupport: true` (review), and the filter the client registers for `/sync` (QA: `GET /user/@alice:localhost/filter/{id}` with the id from a `/sync` request URL) has `room.timeline.unread_thread_notifications: true`. |
| AC-T1-2 | Given `#general` showing N `message-*` rows, when bob posts a thread reply via API to a root that is in view, then 3 s later `message-list` still has N rows and `message-{replyId}` is nowhere in `message-list`. |
| AC-T1-3 | Given a thread reply with `is_falling_back: true`, then no `message-reply-quote` is rendered for it (in the panel); a normal reply still shows its quote (AC-B6-1 passes). |
| AC-T1-4 | Given `#random` opened and scrolled to the bottom, then alice's `m.read` receipt on the last event has `thread_id: "main"` and `channel-unread-{random}` clears (AC-B7-3, AC-A5 pass). Given alice is in `#general` when bob replies in a thread of `#random`, then `channel-unread-{random}` does not increase. |
| AC-T1-5 | Given PRIN-8 landed, then `npm run test:e2e:desktop` and `npm run test:e2e:mobile` pass with only the known fresh-seed skips; the result is recorded in docs/STATUS.md before Wave 8 starts. |
| AC-T1-6 | Given bob reacts via API to a reply inside a thread, then the panel row shows `reaction-{key}` with `data-count` 1 (P1, with DEV-B-22). |

### AC-T2 Timeline source, sends and hooks (PRIN-9)
| ID | Given / When / Then |
|---|---|
| AC-T2-1 | Given a reply sent from the panel, when fetched via API, then its content matches the contract exactly (`rel_type`, `event_id` = root, `is_falling_back: true`, `m.in_reply_to.event_id`). |
| AC-T2-2 | Given a root with no replies, when alice sends the first reply, then `m.in_reply_to.event_id` = root; when she sends a second, it = the first reply's `$` id (never a `~` local echo). |
| AC-T2-3 | Given `sendText(roomId, body, { replyTo, threadRoot })` both set, then it rejects (no event sent). |
| AC-T2-4 | Given a root with 35 API replies, when the thread opens and (if fewer are shown at first) `paginateBack` runs until `hasMore` is false, then all 35 are shown oldest first with no duplicate `message-*` ids and `thread-timeline-start` visible; the initial page size is the SDK's, not asserted. |
| AC-T2-5 | Given a root with 3 replies created via API before alice logged in, then on first render (no thread opened) the summary row shows `3 replies`, the latest reply's relative time and the latest sender's avatar (server summary); after opening the thread the count is still 3 (SDK agrees); the count never decreases except after a redaction. |
| AC-T2-6 | Given a root with no replies, when alice opens the thread and sends a reply, then its local echo row appears in `thread-message-list` within 200 ms and settles to a `$` id (the SDK thread is created on open). |
| AC-T2-7 | Given threads A and B created via API before the list opens, then `useRoomThreads` lists both newest activity first; when bob replies in A, A moves to the top within 3 s without reopening. |
| AC-T2-8 | Given a thread open, when alice selects another room, then `app-shell` has `data-thread-open="false"` and `thread-panel` is gone; coming back does not reopen it. |

### AC-T3 Panel container (PRIN-10)
| ID | Given / When / Then |
|---|---|
| AC-T3-1 | Given desktop and no thread open, then `thread-panel` is not in the DOM, `member-list` is visible and 240 px wide, the header is 48 px, `data-thread-open="false"` (pixel-identical to Phase 2). |
| AC-T3-2 | Given desktop, when a thread opens, then `thread-panel` is visible at the right edge, 360-480 px wide, `member-list` is not visible, `message-list` is still >= 400 px wide, `channel-header` unchanged. |
| AC-T3-3 | When the thread closes, then `member-list` is back (when `useNavUiStore.membersOpen`), same width as before. |
| AC-T3-4 | Given phone, when a thread opens, then `thread-panel` spans the viewport width under `channel-header`, its bottom edge equals `app-shell`'s bottom edge, the room's `message-list` and `composer-input` stay in the DOM but are covered (`inert`, `aria-hidden`), both drawers are closed, and no `main` receipt is sent for room messages that arrive while the thread is open. |
| AC-T3-5 | **manual (device)** Android back closes an open thread before closing drawers or leaving the app. |

### AC-T4 Summary row (DEV-B-18)
| ID | Given / When / Then |
|---|---|
| AC-T4-1 | Given a root with 0 replies, then no `thread-summary-*` is rendered under it. |
| AC-T4-2 | Given alice sent 2 replies from the panel, then `thread-summary-{root}` sits directly under `message-{root}` with `data-count="2"`, `thread-summary-count` `2 replies`, one avatar in `thread-summary-avatars`, `thread-summary-time` `just now`. |
| AC-T4-3 | When bob replies via API, then within 3 s `thread-summary-count` reads `3 replies` and the avatars show 2 users, without reload. |
| AC-T4-4 | When I click the row, then `thread-panel` opens with `data-root` = that root. |
| AC-T4-5 | Given exactly 1 reply, then it reads `1 reply`; after a reload the row still shows the count (from the server summary) before the thread is opened. |
| AC-T4-6 | Given phone, then the row is >= 44 px tall and a tap opens the full-screen thread. |

### AC-T5 "Reply in thread" action (DEV-B-19, DEV-B-21)
| ID | Given / When / Then |
|---|---|
| AC-T5-1 | Given desktop, when I hover a row, then `message-actions` contains `message-action-thread` (after `message-action-reply`); clicking it opens `thread-panel` with `thread-root` showing that message and focus in `thread-composer-input`. |
| AC-T5-2 | Given phone, when I long-press a row, then `message-action-sheet` contains `message-action-thread`; tapping it closes the sheet and opens the full-screen thread. |
| AC-T5-3 | Given the panel, then neither `thread-root` nor any reply row offers `message-action-thread` or `message-action-reply`; react/edit/delete follow the Phase 1 permission rules. |
| AC-T5-4 | Given a root that already has replies, when I use the action, then the existing thread opens (same `data-root`, replies present). |

### AC-T6 ThreadView (DEV-B-20, DEV-B-21)
| ID | Given / When / Then |
|---|---|
| AC-T6-1 | Given an open thread, then `thread-panel` contains, top to bottom: `thread-root` (author, body, timestamp; `message-{rootId}` is not duplicated inside the panel), `thread-replies-divider` (`No replies yet` or `N replies`), `thread-message-list`, `thread-typing` slot, `thread-composer` with `thread-composer-input` placeholder `Replying in thread` and `thread-composer-send`; on desktop also `thread-close`. |
| AC-T6-2 | When I type `Tacos work for me` and press Enter, then a row with `data-sender="@alice:localhost"` appears in `thread-message-list` immediately, settles to a `$` id within 5 s, the divider reads `1 reply`, and `message-list` (room) gains no row. |
| AC-T6-3 | Given alice sends two replies within 5 min, then only the first has `message-group-start` (grouping ignores the fallback `m.in_reply_to`), and no `message-reply-quote` is rendered in the panel. |
| AC-T6-4 | Given 35 replies, then the panel opens scrolled to the bottom; if fewer than 35 rows are shown, scrolling to the top shows `thread-timeline-loading` and loads the rest with anchor drift <= 5 px (AC-B3-2 rule); the end state is all 35 rows in order, no duplicate ids, `thread-timeline-start` visible. |
| AC-T6-5 | Given the panel at the bottom, when bob replies via API, then the row appears within 3 s and the list stays at the bottom. |
| AC-T6-6 | When I click `thread-close`, then `thread-panel` is gone; reopening the same thread shows the same rows without an empty flash. |
| AC-T6-7 | Given the panel, when bob sends typing=true via API, then `thread-typing` reads `Bob Ruiz is typing...` within 3 s (and the room's `typing-indicator` too); typing=false clears both. |
| AC-T6-8 | Given the panel open and at the bottom, when a reply settles, then within 2 s alice's `m.read` receipt is on that reply with `thread_id` = root (QA via API as bob); the room's `main` receipt is unchanged. |
| AC-T6-9 | When I start editing my reply in the panel, then `thread-composer-edit-banner` shows and the room's `composer-edit-banner` does not; Escape in a non-empty `thread-composer-input` clears it, in an empty one closes the panel (desktop). |
| AC-T6-10 | Given a redacted root, then `thread-root` shows `message-redacted` and the composer still sends. |
| AC-T6-11 | Opening a thread moves focus to `thread-composer-input`; closing returns it to `composer-input` (desktop). |

### AC-T7 Threads button and list (DEV-A-17)
| ID | Given / When / Then |
|---|---|
| AC-T7-1 | Given any channel or DM, then `channel-header` shows `header-threads` left of `member-toggle` (DMs: at the right edge); >= 44 px on phone; header height unchanged (48 px desktop, 56 px phone). |
| AC-T7-2 | When I click it, then `thread-list` opens (`data-variant` `popover` on desktop, `sheet` on phone) with one `thread-list-item-{rootId}` per thread showing `-author`, `-snippet`, `-count` (`N replies`), `-time`, `-avatars`; items ordered by `data-ts` descending. |
| AC-T7-3 | Given threads A then B created via API, when bob replies in A, then A is listed above B (relative order only; other runs' threads may be present). |
| AC-T7-4 | When I click an item, then the list closes and `thread-panel` opens with that `data-root`. |
| AC-T7-5 | Given a room with no threads (a channel created in the test), then `thread-list-empty` reads `No threads yet`. |
| AC-T7-6 | Given alice in `#general`, when bob replies in a thread she has not read, then `header-threads-unread` appears within 3 s and `channel-unread-{general}` is unchanged; opening that thread (receipt sent) clears the dot within 3 s. |
| AC-T7-7 | When I press Escape, click outside, or click `thread-list-close`, then the list closes; on phone opening it closes any drawer and vice versa. |
| AC-T7-8 | Given desktop with the list closed, then AC-A2..A4 and AC-M3 pass unchanged. |

### AC-T8 Phone header while a thread is open (DEV-A-18)
| ID | Given / When / Then |
|---|---|
| AC-T8-1 | Given phone and a thread open, then `channel-header` shows `header-back` (>= 44 px) where `header-menu` was, `channel-header-name` reads `Thread`, `header-thread-room` reads the room name, and `header-threads`/`member-toggle` are hidden. |
| AC-T8-2 | When I tap `header-back`, then the thread closes, the normal header returns and the room's `message-list` keeps its scroll position. |
| AC-T8-3 | Given desktop, then `header-back` is never rendered; the header differs from Phase 2 only by `header-threads`. |

### AC-T9 In-thread edits, reactions, delete, media (DEV-B-22, P1)
| ID | Given / When / Then |
|---|---|
| AC-T9-1 | When I edit my reply in the panel, then the row shows `message-edited`, the `m.replace` event's `m.new_content` has no `m.relates_to`, and the room timeline is unchanged. |
| AC-T9-2 | When I react to a reply in the panel, then `reaction-{key}` appears in that row with `data-mine="true"`; bob's reaction via API shows within 3 s. |
| AC-T9-3 | When I delete my reply, then it disappears from the panel and the divider/summary counts drop by 1 (ruling G-2). If Dev B ships a cheap client-side tombstone, the row shows `message-redacted` instead and the counts still drop. |
| AC-T9-4 | When I record from `thread-composer-mic` and send, then a `voice-message` row appears in the panel and the event has the Phase 2 voice contract plus the thread `m.relates_to`. |
| AC-T9-5 | When I attach a PNG via `thread-composer-attach`, then `message-image` appears in the panel and the event carries the thread relation. |

### AC-T10 Demo tooling, seed and docs (PRIN-11, PRIN-12)
| ID | Given / When / Then |
|---|---|
| AC-T10-1 | Given `npm run thread:sample -- --root <id>`, then bob posts one reply with the contract shape into that thread, prints JSON `{ roomId, rootId, replyIds }` and exits 0. |
| AC-T10-2 | Given `npm run thread:sample` with no `--root`, then it posts a root as bob in `#general` (or `--room`), then replies by bob, carol, bob (`--replies`, default 3), and prints the same JSON. |
| AC-T10-3 | Given `npm run seed` on a fresh homeserver, then `#dev` contains a thread (root by carol, 3 replies) and `seed-output.json` has `dev.threadRoot`, `dev.threadReply1..3`; `#general`'s message count and alice's seeded badges are unchanged. (P1; verified on the next reset.) |
| AC-T10-4 | docs/ARCHITECTURE.md has a "Phase 3 deltas" section listing every name or shape that differs from the Shared API table in docs/PHASE3_TICKETS.md. |

### AC-T11 Demo walkthrough (QA-17)
| ID | Given / When / Then |
|---|---|
| AC-T11-1 | `e2e/smoke.spec.ts` step 11 walks desktop demo steps 2-7 (bob via API in place of the script) with a screenshot per sub-step in `e2e/results/demo/11-*`. |
| AC-T11-2 | `e2e/mobile-smoke.spec.ts` step 11 walks phone demo steps 2-6 with screenshots in `e2e/demo-mobile/11-*`. |
| AC-T11-3 | Both projects are green (known fresh-seed skips only) at the end of Wave 8; recorded in docs/STATUS.md. |

## Rulings (PM, 2026-10-08)
| # | Subject | Ruling |
|---|---|---|
| G-1 | AC-A4-2 (docs/ACCEPTANCE.md) said `#dev` has three members with carol absent; PRIN-12 seeds a carol-authored thread root in `#dev`, so carol joins that room on the next `seed:reset`. | Not a defect in either ticket. AC-A4-2 derives the expected membership from the server (`GET /rooms/{dev}/joined_members`), as QA already implemented; the criterion text is updated. Seed authors keep the rule: any seed step in a room adds its author to that room's members, and membership criteria never hard-code a count. |
| G-2 | BUG-7 / AC-T9-3: Synapse strips `m.relates_to` from a redacted event and no longer returns it from `/relations/{root}/m.thread`, so after a reload (or when the SDK re-fetches the thread) a redacted reply cannot be placed in the panel without a client-side memory of its thread. | AC-T9-3 is reworded: the redacted reply **disappears from the panel** and the divider/summary counts drop by one. **Condition**: if Dev B reports a cheap tombstone (e.g. keeping the redacted event in the thread timeline set for the current session only), the row shows `message-redacted` instead and the counts still drop; either outcome passes. The room timeline keeps AC-B9's tombstone behaviour. QA re-runs AC-T9-3 after Dev B's answer. |
