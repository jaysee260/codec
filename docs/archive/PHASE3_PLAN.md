# Phase 3 Plan: Threads

Phases 1-2 shipped the desktop client, the phone layout, the Android APK and voice notes (docs/archive/PHASE2_PLAN.md). Phase 3 adds threads "like Slack, Discord and Element". Tickets: docs/archive/PHASE3_TICKETS.md. Criteria and testids: docs/archive/PHASE3_ACCEPTANCE.md. Status: docs/STATUS.md "Phase 3".

## Goals
1. **Reply in a thread from any message**, desktop and phone, with the replies kept out of the channel timeline.
2. **Find threads again**: a summary row under the root message and a per-room Threads list, both opening the thread.
3. **Interoperable**: threads created here are threads in Element Web on the same homeserver, and Element's threads show up here.

## Product decision: message-anchored threads, Discord-style presentation
Discord threads are named sub-channels in the sidebar; Slack and Element threads hang off a message. Matrix only has the message-anchored model (the `m.thread` relation, MSC3440, stable in Synapse 1.162 and in matrix-js-sdk v43). Building Discord's sub-channel model would mean inventing a room-per-thread scheme that no other Matrix client reads, and `rc_room_creation` is still limited on this homeserver. So Phase 3 builds **Slack/Element semantics with Discord's look**:

| Element | Behaviour |
|---|---|
| Thread root | Any `m.room.message` in a room. Threads do not nest: "Reply in thread" is never offered inside a thread. |
| Summary row | Under the root in the channel timeline: `N replies · last reply time · participant avatars`; click opens the thread. |
| Thread panel | Desktop: right column (replaces the member panel while open, as Discord does). Phone: full-screen with a back button in the header. Root at the top, divider `N replies`, replies oldest first, composer "Replying in thread". |
| "Reply in thread" | Hover-toolbar action on desktop, long-press sheet item on phone. |
| Threads list | "Threads" button in the channel header (dot when any thread in the room has unread) opening a per-room list sorted by latest activity. |
| Main timeline | Thread replies never appear as rows or as reply quotes; the root stays where it is. |

## What "lands well" means
1. The stakeholder completes the desktop and phone demo scripts below with no dead click, duplicate message, or thread reply leaking into the channel.
2. A thread started here is a thread in Element Web (same homeserver), and bob's API replies tick the summary count live.
3. The Phase 1 `desktop` project and the Phase 2 `mobile` project stay green after `threadSupport: true`, plus the new thread specs; nothing on the running homeserver changes.

## In scope
| Area | Owner | Deliverable |
|---|---|---|
| Thread core | Principal | `threadSupport: true`, bridge thread events, timeline-source abstraction (`useTimeline(source)`, `paginateBack(source)`), `threadRoot` on sends, thread-aware relations and receipts, `useThreadSummary`, `useRoomThreads`, `useThreadStore`, unread split (room badge = main timeline; thread unread feeds the Threads dot) |
| Panel container | Principal | Desktop right-column swap, phone full-screen overlay over the still-mounted conversation, Android back, closes on room change |
| Demo tooling | Principal | `scripts/send-thread-sample.mjs` (`npm run thread:sample`, bob replies live), seed threads in `#dev` for the next reset, ARCHITECTURE deltas |
| Conversation | Dev B | Summary row, "Reply in thread" action (toolbar + sheet), `ThreadView` (root, divider, list, composer, typing, receipts), main-timeline hygiene, in-thread edits/reactions/delete/voice (P1) |
| Navigation | Dev A | `header-threads` button + unread dot, Threads list (popover on desktop, sheet on phone), phone header back button while a thread is open |
| QA | QA | API helpers (thread reply, `/threads`, `/relations`, threaded receipts), `e2e/threads.spec.ts` (desktop), `e2e/mobile-threads.spec.ts`, demo step 11 with screenshots in both smoke specs, regression gate run, docs/BUGS.md Phase 3 |

## Out of scope
Thread notification settings and muting · moving messages into a thread · nested threads · thread search · Discord-style named thread channels in the sidebar · quote-replies inside a thread (`is_falling_back: false`; `message-action-reply` is hidden in the panel) · thread-scoped typing (Matrix has none; the panel shows the room's typing) · forward pagination of a thread opened from the list (it loads the newest page and paginates back) · E2EE, push, calls (unchanged).

## Desktop demo script (stakeholder, laptop)
Prep by us: homeserver up, `npm run dev`, a terminal ready for `npm run thread:sample -- --root <id>` (bob replies into alice's thread; the script prints the ids it posted).

| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Log in as `alice` / `password123`; `#general` opens | The Phase 1 layout unchanged, plus a **Threads** button beside the members button in the header. |
| 2 | Hover any bob message (e.g. "Lunch today? Thinking tacos."), click **Reply in thread** | The member column becomes a thread panel: the message at the top, "No replies yet", a composer reading "Replying in thread" with focus. |
| 3 | Type `Tacos work for me`, Enter; then `Noon?`, Enter | Both replies appear in the panel in order under alice. The channel timeline gains **no** rows; under bob's message a summary row reads `2 replies · just now` with alice's avatar. |
| 4 | We run `npm run thread:sample -- --root <id>` | Within 2 s bob's reply appears in the panel, the summary reads `3 replies`, bob's avatar joins. |
| 5 | Click the panel's X; we run the script again | The member column is back, the summary row ticks to `4 replies`, the **Threads** button shows a dot. |
| 6 | Click **Threads** | A list with the thread at the top: bob's name, the root snippet, `4 replies`, `just now`, avatars. |
| 7 | Click the item | The panel reopens with the 4 replies in order; the dot is gone. |
| 8 | Close it, click the summary row under bob's message | Same panel. Optional: Element Web as bob shows the same thread with the same 4 replies. |

## Phone demo script (stakeholder, Android device; prep as in Phase 2 plus the script above)
| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Open the app, log in as alice | `#general` full-screen; the header shows menu, `#general`, **Threads** and members buttons. |
| 2 | Long-press a bob message, tap **Reply in thread** | The thread fills the screen: back arrow + `Thread` in the header, the root at the top, composer "Replying in thread". |
| 3 | Type `From my phone`, send | The reply appears in the thread; the keyboard stays under the composer. |
| 4 | Tap the back arrow | Back in `#general`; a summary row `1 reply` under the root. |
| 5 | We run bob's reply script | Summary ticks to `2 replies`; the **Threads** button shows a dot. |
| 6 | Tap **Threads**, tap the thread | A bottom sheet lists it; tapping opens the full-screen thread with both replies; back returns to the channel. |

## Decisions
| Topic | Decision |
|---|---|
| Panel vs member panel (desktop) | The thread panel **replaces** the member column while open; `useNavUiStore.membersOpen` is untouched and the member panel returns on close. Desktop is pixel-identical when no thread is open. |
| Reply wire shape | Built explicitly by `sendText`/`sendFile`/`sendVoiceMessage` with `threadRoot` (deterministic, QA-verifiable); the SDK's `threadId` send parameter is not used. |
| Room badges | `threadSupport: true` makes the SDK ask Synapse for `unread_thread_notifications`, splitting counts into main vs per-thread. `unreadByRoom` becomes the **main-timeline** count (`getRoomUnreadNotificationCount`), so a `main` receipt still clears the badge; thread unread drives `header-threads-unread` via `room.hasThreadUnreadNotification()`. |
| Fallback quotes | A reply whose `m.relates_to.is_falling_back` is `true` carries `m.in_reply_to` only for non-threaded clients; our rows never render it as a quote and grouping ignores it. |
| Typing | Room-scoped in Matrix; the panel shows the room's typing as `thread-typing`, the channel keeps its own. Known limitation. |
| Testids | Two lists and two composers on one page: inside the panel every `composer-*`, `message-list`, `timeline-*`, `typing-indicator` testid gets the `thread-` prefix; rows keep `message-{eventId}`; the root row is `thread-root`. |
| Threads list mount | Dev A owns it entirely: popover anchored to `header-threads` on desktop, bottom sheet on phone; the shell does not mount it. |
| Phone presentation | The panel is an **overlay** (`position: fixed`, under the header) over the room's conversation, which stays mounted with `inert` + `aria-hidden` so its scroll position survives (demo step 4) and its read-receipt hook pauses while covered (alice must not "read" rows she cannot see). |
| Phone close | `header-back` (Dev A, in the header) is the only close on phone; `thread-close` is desktop-only. One testid, one action. |
| Seed | Seeded threads go in `#dev` so the fresh-seed counts on `#general` (AC-B1-1, AC-B3-1, demo step 3) stay valid; the demo uses the live script in `#general`. |

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| `threadSupport: true` flips SDK behaviour for every timeline: thread replies are routed into `Thread` timeline sets, every receipt gains `thread_id`, the sync filter asks for per-thread unread counts | Silent regressions in Phase 1/2 | The bridge already ignores non-main timeline sets; PRIN-8 ships the flip plus the badge rule and QA runs the `desktop` and `mobile` projects **before** any thread UI lands (Wave 7 gate, QA-17). |
| Server summary vs SDK thread state diverge (server `count` is a snapshot; `thread.length` only counts loaded replies; local echoes) | Count flickers or goes down | `useThreadSummary` shows `max(server, sdk)`, counts local echoes, never decreases except on redaction; the panel's divider uses the same hook. |
| First reply to a fresh root: no SDK `Thread` exists yet | Local echo lost, panel empty | `openThread` get-or-creates the `Thread` (`room.getThread(root) ?? room.createThread(...)`) before the panel mounts its composer (AC-T2-6). |
| Replies from clients without thread support (plain `m.in_reply_to` to a thread reply) | They land in the main timeline | Spec behaviour; they render as normal quote replies there. Our `is_falling_back: true` replies render as quotes on those clients, which is what the fallback is for. |
| Receipts per thread: Synapse keeps one receipt per thread plus `main` and refuses to move any backwards | QA false negatives | QA's `receipt()` takes a `threadId`; thread receipts are asserted by `thread_id` in the receipt data; main receipts with `thread_id: main`. |
| After the flip alice has several `m.read` receipts per room (`main` + one per thread), so the Phase 1 fixtures' "newest receipt" logic (`readReceiptOf`, `unreadFor`) can pick a thread receipt | AC-B7-3 and unread assertions flake; the Wave 7 gate goes red for a fixture reason | QA-14's fixture half (main-only receipt selection) lands **before** the QA-17 gate run; recorded as a gate precondition in the Sequence. |
| Pagination through `/relations` (newest first, `next_batch`) | Wrong order or duplicates | SDK thread timeline pagination (`paginateEventTimeline` on `thread.liveTimeline`); QA's >30-reply case checks strict order and no duplicate ids. `rc_message` was raised in Phase 1, so posting 35 replies via API is quick. |
| Dirty DB: every test run leaves threads in `#general` | Absolute positions in the Threads list are meaningless | Every test creates its own root; list tests assert the relative order of their own threads; seeded threads live in `#dev`; nothing depends on a fresh seed. |
| Thread opened from the list whose root is outside the loaded window | Panel has no root to show | `openThread` fetches the root via `fetchEvent`; the summary row in the channel appears once the root is in the loaded window (documented, not a bug). |
| Redacted root | Panel/list confusion | The panel renders `message-redacted` as the root; the list hides redacted roots. |
| Element interop | A thread from Element renders differently | Element sends the same `m.thread` shape with `is_falling_back: true`; demo step 8 covers it by hand. |

## Advisor consultations (recorded per the stakeholder's instruction)
| # | Topic | Options considered | Advisor's position / outcome |
|---|---|---|---|
| 1 | PM design review before writing (panel placement, main-timeline exclusion, explicit reply shape, receipts, typing, no in-thread quote replies, testid prefix, list source, summary source, numbering) | As listed under Decisions | Adopted, with corrections now in this plan: `unreadByRoom` must switch to the **main-only** count (v43 `getUnreadNotificationCount` sums thread notifications, so a `main` receipt would never clear the badge) and the Threads dot comes from per-thread counts, not from fetching the list; fallback `m.in_reply_to` must not render quotes nor break grouping; the bridge must forward `ThreadEvent.*` and bump a version that reaches the root row; get-or-create the SDK `Thread` before the panel composer mounts; `getReactions`/`fetchEvent`/`canRedactEvent` thread-aware; the Threads list is Dev A's popover/sheet; `header-back` is the only phone close; root row testid `thread-root`; composer state keyed by source; seeded threads in `#dev`. |
| 2 | Advisor agent's verification of the v43 thread API and the wire shape (relayed by the orchestrator) | Brief said `is_falling_back_to_thread` | The spec key is **`is_falling_back`** (boolean); a deliberate in-thread quote reply has `is_falling_back: false`. Reply count is `thread.length`; the list is `room.fetchRoomThreads()` -> `GET /v1/rooms/{id}/threads?include=all` with `next_batch` paging; root events carry `unsigned.m.relations.m.thread = { count, current_user_participated, latest_event }`. The probe is in the tree as `docs/advisor/thread-probe.mjs` (Principal and QA start from it). Used throughout the Phase 3 docs; the Principal's ARCHITECTURE deltas may still rename internal hooks. |
| 3 | PM review of the finished docs | Phone panel: replace `Conversation` vs overlay it; QA fixture impact of per-thread receipts; pinning the SDK's initial thread page size; one relative-time helper; `openThreadRootId` field | Adopted: the phone panel is an overlay over the mounted conversation (scroll kept, receipts paused while covered); QA-14 makes `readReceiptOf`/`unreadFor` main-only and lands before the gate; AC-T2-4/AC-T6-4 assert the end state (all replies in order, no duplicates) rather than an initial page size (the SDK's first load is `paginateEventTimeline` with its default limit, and it resets the thread timeline on that load, so the bridge also forwards thread `TimelineReset`); `formatRelative(ts)` in `src/lib/format.ts` with pinned strings; `useThreadStore.openThreadRootId` kept as a field. |

## Sequence
| Wave | Who | Output |
|---|---|---|
| 7 | Principal | PRIN-8 (flip + badge rule + hygiene) first, then PRIN-9, 10, 11. QA lands the QA-14 fixture half (main-only receipts) in parallel, then runs the `desktop` and `mobile` projects as soon as PRIN-8 lands (QA-17 gate) and files regressions before any UI work depends on them. Dev A / Dev B / QA start P0s on day 1 against the Shared API table. |
| 8 | Dev A, Dev B, QA in parallel | P0 tickets, then P1 |
| 9 | All | Both demo scripts dry-run (desktop smoke step 11, phone smoke step 11), Element interop check by hand, docs/BUGS.md triage, docs/STATUS.md final |
