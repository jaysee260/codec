# Phase 3 Tickets

Priorities: **P0** = a demo script in docs/PHASE3_PLAN.md breaks without it. P1 = demo noticeably better. P2 = polish. Work top-down inside your column. Estimates are focused hours. Numbering continues from Phase 2 (Principal resumes at 8, Dev A at 17, Dev B at 18, QA at 14).

## Ownership map (hard rule, as docs/PHASE2_TICKETS.md)
| Owner | Owns (may create/edit) | Must not edit |
|---|---|---|
| Principal | `src/app/**`, `src/store/**` (new `src/store/thread.ts`), `src/lib/**`, `seed/**`, `scripts/**`, `package.json`, `docs/ARCHITECTURE.md` | - |
| Dev A | `src/features/navigation/**` | anything else |
| Dev B | `src/features/conversation/**` (incl. its `index.ts` export of `ThreadView`) | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:*` script lines in `package.json` | anything else |

Shared-layer needs go in your report as **Request to Principal: file, function, shape, why**. Devs build against the table below from day 1; names are **subject to the Principal's ARCHITECTURE deltas** (docs/ARCHITECTURE.md "Phase 3 deltas" wins), wire shapes in docs/PHASE3_ACCEPTANCE.md are not.

## Shared API (Principal exposes; devs consume only)
| Module | Export | Shape / rule |
|---|---|---|
| `src/lib/matrix/client.ts` | `startClient` options | `threadSupport: true`; `getClient().supportsThreads()` is true. The SDK now routes `m.thread` replies into per-root `Thread` timeline sets (main timelines no longer contain them), adds `thread_id` to every receipt and asks Synapse for per-thread unread counts. |
| `src/store/timeline.ts` | `TimelineSource`, `sourceKey(source)` | `{ roomId: string, threadRootId?: string }`; `sourceKey` = `threadRootId ?? roomId`, the key for every per-source UI state (reply/edit/jump, composer drafts). |
| | `useTimelineStore.paginateBack(source, limit = 30)` | Main: as today. Thread: `client.paginateEventTimeline(thread.liveTimeline, { backwards: true, limit })` (the SDK calls `/relations/{root}/m.thread`). `canPaginateBack`, `isPaginating` and the thread snapshot are keyed by `sourceKey`; the thread snapshot excludes the root. |
| | `threadVersion` | Bumps on `ThreadEvent.New/Update/NewReply/Delete` and on `RoomEvent.Timeline` / `RoomEvent.TimelineReset` for thread timeline sets (bridge; the SDK resets a thread's timeline on its first load). The main `version` bumps too, so root rows re-render their summary. |
| `src/store/hooks.ts` | `useTimeline(source)` | Same return as `useRoomTimeline` (`events, allEvents, hasMore, isPaginating, version, paginateBack(limit?)`); `useRoomTimeline(roomId)` stays as `useTimeline({ roomId })`. Thread `events`: oldest first, root excluded, `isDisplayableEvent`-filtered. |
| | `useThreadSummary(event)` | `{ count, latestTs, participants: string[], hasUnread, participated } \| null`. `null` unless the event is a thread root (an SDK `Thread` exists or `unsigned.m.relations.m.thread` is present). Before the thread is loaded: server summary (`count`, `latest_event.origin_server_ts`, `[latest_event.sender]`, `current_user_participated`). After: SDK (`thread.length`, `lastReply()`, distinct reply senders newest first max 5, `hasCurrentUserParticipated`); `count = max(server, sdk)`, counts local echoes, only a redaction lowers it. `hasUnread` = `room.getThreadUnreadNotificationCount(rootId) > 0`. Re-renders on `threadVersion`. |
| | `useRoomThreads(roomId)` | `{ threads: ThreadInfo[], loading, error, refresh() }`, `ThreadInfo = { rootId, root: MatrixEvent, count, latestTs, participants, hasUnread, participated }` sorted `latestTs` desc, redacted roots dropped. First call runs `room.fetchRoomThreads()` (`GET /v1/rooms/{id}/threads?include=all`, follows `next_batch` up to 3 pages), then reads `room.getThreads()`; live on `threadVersion`. |
| `src/store/thread.ts` | `useThreadStore` | `{ open: { roomId, rootId } \| null, openThreadRootId: string \| null, openThread(rootId, roomId?), closeThread() }`. `openThread` get-or-creates the SDK thread (`room.getThread(rootId) ?? room.createThread(rootId, rootEvent, [], false)`), fetches the root via `fetchEvent` when it is not in the timeline, closes phone drawers, and (desktop) is a no-op for the member panel state. `onRoomSelected` -> `closeThread()`. Selector `useOpenThreadRootId()`. |
| `src/store/rooms.ts` | `unreadByRoom` **(changed)**, `threadUnreadByRoom` | `unreadByRoom[roomId]` = `room.getRoomUnreadNotificationCount(Total)` (main timeline only, so a `main` receipt still clears it); `threadUnreadByRoom[roomId]` = `room.hasThreadUnreadNotification()`. Both refresh on `RoomEvent.Receipt`/`UnreadNotifications`. |
| `src/lib/matrix/actions.ts` | `sendText(roomId, body, { threadRoot?, html?, mentions?, replyTo? })` | `threadRoot` adds the contract `m.relates_to` (`is_falling_back: true`, `m.in_reply_to` = newest server-acked reply, else the root). `replyTo` with `threadRoot` rejects. |
| | `sendFile(roomId, file, { threadRoot? })`, `sendVoiceMessage(roomId, blob, { ...meta, threadRoot? })` | Same relation added to the content. |
| | `editText`, `redactEvent`, `sendReaction`, `toggleReaction`, `getReactions`, `canRedactEvent`, `canEditEvent`, `fetchEvent` | Thread-aware: events are found via `room.findEventById` then `thread.findEventById`; relations read from `event.getThread()?.timelineSet ?? room.getUnfilteredTimelineSet()`. Signatures unchanged. |
| | `sendReadReceipt(roomId, event)` | Unchanged signature; the SDK now sends `thread_id` (`"main"` or the root id). Use it from the panel on the newest reply. |
| `src/lib/matrix/utils.ts` | `isThreadReply(event)`, `getThreadRootId(event)`, `getThreadServerSummary(event)` | Wire-content readers: `rel_type === 'm.thread'`; its `event_id`; `unsigned.m.relations.m.thread` -> `{ count, latestEvent, participated } \| null`. |
| | `isDisplayableEvent` **(changed)** | Additionally drops thread replies (belt and braces; the SDK already keeps them out of main timelines). |
| | `getReplyTargetId` **(changed)** | Returns `undefined` when `m.relates_to.is_falling_back === true` (a fallback, not a quote). |
| `src/app/Shell.tsx` | panel container | Desktop: while `useThreadStore.open`, the right aside renders `<ThreadView roomId rootId/>` (width `--thread-w`) instead of `<MemberPanel/>`, regardless of `useNavUiStore.membersOpen`; closing restores it. Phone: `Conversation` stays mounted and `ThreadView` is stacked over it (`position: fixed`, below the header, `inert` + `aria-hidden` on the covered conversation, like the Phase 2 `Drawer`); Android back closes the thread before drawers. `app-shell[data-thread-open]`. The shell never mounts the Threads list. |
| `src/app/theme.css` | `--thread-w: 400px` | Desktop panel width. |
| `src/lib/format.ts` | `formatRelative(ts)` | One helper for both owners: `just now` (< 60 s), `N min ago`, `N h ago`, `yesterday`, else the short date. |
| `@/features/conversation` | `ThreadView` | `<ThreadView roomId rootId/>` exported from Dev B's `index.ts`; the shell passes nothing else. |
| `scripts/send-thread-sample.mjs` | `npm run thread:sample` | `--as bob --room '#general:localhost' [--root $id] [--replies 3]`; prints `{ roomId, rootId, replyIds }`. |

---

## Principal

| ID | P | Title | Est |
|---|---|---|---|
| PRIN-8 | P0 | `threadSupport: true`, bridge thread events, badge rule, reply/display hygiene, regression | 5h |
| PRIN-9 | P0 | Timeline source, `threadRoot` sends, thread pagination, `useThreadSummary`, `useRoomThreads`, `useThreadStore` | 7h |
| PRIN-10 | P0 | Thread panel container: desktop column swap, phone full-screen, Android back | 3h |
| PRIN-11 | P0 | `scripts/send-thread-sample.mjs` + ARCHITECTURE Phase 3 deltas | 2h |
| PRIN-12 | P1 | Seed threads in `#dev` | 2h |

**PRIN-8 Flip + hygiene** - `client.ts`: `threadSupport: true`. `bridge.ts`: keep ignoring non-main timeline sets for the main snapshot, but forward `ThreadEvent.New/Update/NewReply/Delete` and `RoomEvent.Timeline` whose timeline set belongs to a `Thread` to `refreshThread(roomId, rootId)` + `threadVersion` (and bump `version`); `RoomEvent.Receipt` already refreshes rooms. `rooms.ts`: `unreadByRoom` from `getRoomUnreadNotificationCount`, new `threadUnreadByRoom`. `utils.ts`: `isThreadReply`, `getThreadRootId`, `getThreadServerSummary`, `isDisplayableEvent` drop, `getReplyTargetId` fallback rule. `actions.ts`: thread-aware lookups and relations (`getReactions`, `fetchEvent`, `canRedactEvent`, `editText`, `redactEvent`, reactions). Run `e2e/shell.spec.ts` + `e2e/smoke.spec.ts` yourself before reporting; QA runs both full projects (AC-T1-5). AC: AC-T1-1..4, AC-T1-6 (core half).

**PRIN-9 Source + sends + hooks** - `timeline.ts`: `TimelineSource`, `sourceKey`, thread snapshots (`eventsBySource`), `paginateBack(source)`, `refreshThread`. `hooks.ts`: `useTimeline(source)` (keep `useRoomTimeline`), `useThreadSummary(event)`, `useRoomThreads(roomId)`. `thread.ts`: `useThreadStore` per the table incl. get-or-create (`room.createThread`), root fetch, `onRoomSelected` close, `useOpenThreadRootId`. `actions.ts`: `threadRoot` on `sendText`/`sendFile`/`sendVoiceMessage` building the contract (`m.in_reply_to` = `thread.lastReply(ev => !isPendingEvent(ev))?.getId() ?? root`), reject `replyTo` + `threadRoot`. Reference: `docs/advisor/thread-probe.mjs` (the Advisor's probe against this Synapse: wire shape, `/threads` paging, `unsigned.m.relations.m.thread` in `/messages` and `/sync`, `/relations` order). Verify with probes of your own: first reply to a fresh root echoes locally, 35-reply pagination order, server summary before fetch. AC: AC-T2-1..8.

**PRIN-10 Panel container** - `Shell.tsx` desktop: aside renders `ThreadView` when open (`--thread-w`, `.members` rules unchanged otherwise, `:empty` collapse kept); phone: `ThreadView` overlays the still-mounted `Conversation` under the header (`inert` + `aria-hidden` on it, scroll position kept); `data-thread-open`; `formatRelative` in `format.ts`; `@capacitor/app` back button order: thread -> sheets/drawers -> `minimizeApp`. Desktop must be pixel-identical when no thread is open (`npm run verify:phone` + a before/after screenshot of `app-shell`). AC: AC-T3-1..5.

**PRIN-11 Sample script + deltas** - `scripts/send-thread-sample.mjs` modelled on `send-voice-sample.mjs` (login as bob/carol, `PUT /send`, contract content, fetch back and validate, JSON out); `thread:sample` in `package.json`. docs/ARCHITECTURE.md "Phase 3 deltas" (names, store shapes, SDK gotchas: thread timeline sets, `thread_id` on receipts, `getUnreadNotificationCount` sums threads, `createThread` for fresh roots). AC: AC-T10-1/2/4.

**PRIN-12 Seed threads** - `seed/seed.ts`: `DEV` script gets `threadRoot` + 3 replies (carol root; bob, alice, carol) with the contract relation and keys `dev.threadRoot`, `dev.threadReply1..3`; no change to `#general`/`#random`; document in docs/SEED_DATA.md. Takes effect on the next `seed:reset` (nobody resets now). AC: AC-T10-3.

---

## Dev A - Navigation (`src/features/navigation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-A-17 | P0 | `header-threads` button + unread dot + Threads list (popover / sheet) | 4h |
| DEV-A-18 | P0 | Phone header while a thread is open: `header-back`, `Thread` title | 2h |
| DEV-A-19 | P2 | Threads list polish | 2h |

**DEV-A-17 Threads button + list** - `ChannelHeader.tsx`: `header-threads` (icon button, title "Threads") left of `member-toggle`, rendered for DMs too; `header-threads-unread` from `useRoomStore.threadUnreadByRoom[roomId]`. `components/ThreadList.tsx` + css: `useRoomThreads(roomId)`; desktop popover anchored under the button (like `space-menu`), phone `Dialog` sheet variant (`thread-list[data-variant]`); items per the registry with `previewText(root)`, `formatRelative`, avatars via `avatarUrlOf`; `thread-list-empty`; loading state; click -> `useThreadStore.openThread(rootId)` then close; Escape / outside click / `thread-list-close`; on phone opening it calls `useLayoutStore.closeAll()`. 44 px items on phone. AC: AC-T7-1..8.

**DEV-A-18 Phone header in a thread** - `ChannelHeader.tsx`: when `useOpenThreadRootId()` and `useIsPhone()`: `header-back` (calls `closeThread()`) instead of `header-menu`, name `Thread`, `header-thread-room` with `#name`/`@name`, hide `header-threads` and `member-toggle`. Desktop header untouched (no `header-back`). AC: AC-T8-1..3.

**DEV-A-19 Polish** - relative times re-render every minute, keyboard navigation in the popover, hover preview of the latest reply, item `data-selected` for the open thread. No new AC.

---

## Dev B - Conversation (`src/features/conversation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-B-18 | P0 | `ThreadSummary` row under thread roots | 3h |
| DEV-B-19 | P0 | "Reply in thread" action (toolbar + long-press sheet) | 2h |
| DEV-B-20 | P0 | `ThreadView`: root, divider, list, composer, typing, receipts | 6h |
| DEV-B-21 | P0 | Main-timeline and panel hygiene (no leaked rows, no fallback quotes, grouping, hidden actions) | 2h |
| DEV-B-22 | P1 | In-thread edits, reactions, delete, voice notes, uploads | 3h |

**DEV-B-18 Summary row** - `components/ThreadSummary.tsx` + css mounted by `MessageRow` under the body when `useThreadSummary(event)` is non-null and `count > 0`: `thread-summary-{rootId}` (`data-count`), `thread-summary-avatars` (max 3, `avatarUrlOf`), `thread-summary-count` (`1 reply` / `N replies`, accent colour), `thread-summary-time` (relative, `formatRelative` or local helper), hover/active states, >= 44 px on phone; click -> `openThread(rootId)`. Rows must re-render on `threadVersion` (memo deps). AC: AC-T4-1..6.

**DEV-B-19 Reply in thread action** - `MessageActions.tsx` and `MessageActionSheet.tsx`: `onThread` prop rendering `message-action-thread` ("Reply in thread"); `MessageRow` wires it to `openThread(event.getId())` (threads do not nest: for a reply inside the panel the prop is omitted). The sheet closes first on phone. AC: AC-T5-1/2/4.

**DEV-B-20 ThreadView** - `components/ThreadView.tsx` + css, exported from `index.ts`: `thread-panel[data-root]`; header row with title and `thread-close` (desktop only); `thread-root` rendered by a root-mode `MessageRow` (prop `asThreadRoot`: testid `thread-root`, no summary row, no thread/reply actions); `thread-replies-divider` from `useThreadSummary`; `MessageList` and `Composer` take a `source: TimelineSource` plus `testidPrefix="thread-"` (every `data-testid` inside goes through one `tid(name)` helper); `useRoomEvents(source)`, `usePagination(source)`, `useReadReceipt(source, atBottom)` (receipt on the newest reply; the SDK adds `thread_id`; the room list's instance pauses while `useOpenThreadRootId()` is set on phone, because it is covered), `useTypingNotifier(roomId)` unchanged, `TypingIndicator` rendered as `thread-typing`; composer placeholder `Replying in thread`, sends with `threadRoot`; `useConversationUi` keyed by `sourceKey(source)`; focus management (open -> `thread-composer-input`, close -> `composer-input`); Escape rule; `thread-error` on root fetch failure; redacted root. Keep AC-B3 anchoring and stick-to-bottom in the panel. AC: AC-T6-1..11.

**DEV-B-21 Hygiene** - `useRoomEvents`/`MessageRow`: never render `isThreadReply` events in the main list (guard beyond the store filter), no `ReplyQuote` for fallback replies (`getReplyTargetId` already returns undefined; make `buildTimelineItems` use the same helper so grouping holds), no `message-action-thread`/`message-action-reply` inside the panel. Verify with bob's API replies that `message-list` row counts never move. AC: AC-T1-2/3 (render half), AC-T5-3, AC-T6-3.

**DEV-B-22 In-thread features** - edit (`editText` on a reply; banner in the thread composer only), reactions and picker inside panel rows (`getReactions` is thread-aware), delete dialog, `thread-composer-mic` -> `sendVoiceMessage(..., { threadRoot })`, `thread-composer-attach` -> `sendFile(..., { threadRoot })`, upload progress inside the panel. AC: AC-T9-1..5, AC-T1-6.

---

## QA (`e2e/**`, `playwright.config.ts`)

| ID | P | Title | Est |
|---|---|---|---|
| QA-14 | P0 | API helpers + fixtures + project config for threads | 3h |
| QA-15 | P0 | `e2e/threads.spec.ts` (desktop, AC-T1..T7, T9) | 5h |
| QA-16 | P0 | `e2e/mobile-threads.spec.ts` (phone: sheet action, full-screen, back, list sheet) | 3h |
| QA-17 | P0 | Regression gate after PRIN-8 + demo step 11 in both smoke specs | 2h |
| QA-18 | P1 | docs/BUGS.md Phase 3 section | 1h |

**QA-14 Helpers** - `e2e/fixtures/matrix-api.ts`: `sendThreadReply(roomId, rootId, body, extra?)` (contract content; `m.in_reply_to` = latest reply from `getRelations` or the root), `getThreads(roomId)` (`/v1/rooms/{id}/threads?include=all`, follows `next_batch`), `getRelations(roomId, rootId)` (`/relations/{root}/m.thread?dir=b&limit=50`, returns chunk newest first + `next_batch`), `receipt(roomId, eventId, threadId?)` (body `{ thread_id }`), `getReceipts` returning `thread_id`, **`readReceiptOf` and `unreadFor` consider only receipts whose `thread_id` is `"main"` or absent** (after the flip alice has one receipt per thread; this fixture half lands before the QA-17 gate run), `threadReceiptOf(roomId, userId, rootId)`, `threadSummaryOf(roomId, rootId)` (from `getEvent` unsigned). Start from `docs/advisor/thread-probe.mjs` for the request shapes. `e2e/fixtures/ui.ts`: `openThreadFromRow(page, rootId)`, `replyInThread(page, text)`, `closeThread(page)`, `openThreadsList(page)`; `e2e/fixtures/mobile.ts`: `longPressThread(page, rootId)`. `playwright.config.ts`: `threads.spec.ts` in `desktop` (already matched), `mobile-threads.spec.ts` added to the `mobile` regexes. No new script lines needed.

**QA-15 Desktop suite** - `e2e/threads.spec.ts`, each test creates its own root (`typeAndSend` as alice or `bob.send`), dirty-seed safe: AC-T1-2/3/4 (receipt `thread_id: main`, badge behaviour), AC-T2-1/2/4/5/7/8 (shape via `getEvent` field by field; 35 replies via `sendThreadReply` in a loop; summary-before-open via a fresh page), AC-T3-1..3, AC-T4-1..5, AC-T5-1/3/4, AC-T6-1..11 (typing via `bob.typing`, receipt via `threadReceiptOf`), AC-T7-1..8 (relative order of own threads only), AC-T9 (P1, at the end). Note manual criteria (AC-T3-5) in the spec header.

**QA-16 Mobile suite** - `e2e/mobile-threads.spec.ts`: AC-T3-4, AC-T4-6, AC-T5-2 (CDP long-press -> sheet -> `message-action-thread`), AC-T7-1/2/7 (`sheet` variant, drawers interplay), AC-T8-1..3, keyboard/safe-area of `thread-composer` by the AC-V6-1 rules (bottom edge, 16 px font, 44 px buttons).

**QA-17 Gate + demo steps** - (a) as soon as PRIN-8 lands (and QA-14's main-only receipt fixtures are in): `npm run test:e2e:desktop` and `npm run test:e2e:mobile`, results and any regression rows into docs/STATUS.md / docs/BUGS.md before Wave 8 UI work is accepted (AC-T1-5); (b) `smoke.spec.ts` step 11 (desktop demo 2-7, `stepShot(page, 11, ...)` per sub-step) and `mobile-smoke.spec.ts` step 11 (phone demo 2-6, `phoneShot`), bob via `sendThreadReply`; (c) final full runs at the end of Wave 8 (AC-T11-3).

**QA-18 Bug log** - docs/BUGS.md "Phase 3" section, spec commands for the two new files, severity note: S1 if a thread reply leaks into the channel or the Phase 1/2 suites regress after the flip.

## P0 set (both demo scripts work with exactly these)
PRIN-8, 9, 10, 11 · DEV-A-17, A-18 · DEV-B-18, B-19, B-20, B-21 · QA-14, 15, 16, 17. Total **49 h** (Principal 17 h, A 6 h, B 13 h, QA 13 h). The Principal is the critical path in Wave 7; PRIN-8 goes first because the regression gate depends on it, and Dev B can build DEV-B-18/19 against the hook signatures before PRIN-9 lands. Dev A finishes early and takes DEV-B-22 if Dev B is behind (file names coordinated via STATUS notes as before). P1 (seed threads, in-thread features, bug log): 6 h. P2: 2 h.
