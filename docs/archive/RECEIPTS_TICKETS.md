# Read receipts Tickets

Priorities: **P0** = the demo script in docs/archive/RECEIPTS_DEMO.md breaks without it. P1 = demo noticeably better ("+N", truncation, focus polish; cut first in the order given in docs/archive/RECEIPTS_ACCEPTANCE.md "P0 / P1 summary"). P2 = polish. Work top-down inside your column. Estimates are focused hours. Prefixes are `PRIN-R*`, `DEV-A-R*`, `DEV-B-R*`, `QA-R*` (not Phase 7 numbering). Waves A (plan + core), B (features + tests), C (fix + regression); see docs/archive/RECEIPTS_PLAN.md.

## Ownership map (hard rule, as docs/archive/PHASE6_TICKETS.md)
| Owner | Owns (may create/edit) | Must not edit |
|---|---|---|
| Principal | `src/lib/**` (new `src/lib/matrix/receipts.ts`), `src/store/**` (new `src/store/receipts.ts`), `src/app/**` **except** the toggle mount in `UserFooter.tsx`, `scripts/**` (incl. the `receipts` area in `scripts/select-e2e.mjs`), `homeserver/**`, `docs/ARCHITECTURE.md` "Read receipts deltas", unit tests `src/**/*.test.ts` | `src/features/**`, `e2e/**` |
| Dev A | `src/features/receipts/**` (new; exports from its `index.ts`), the toggle's mount in `src/app/UserFooter.tsx` | anything else |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md` "Read receipts", the `test:*` script lines in `package.json` | anything else |
| PM | `docs/RECEIPTS_*.md`, `docs/STATUS.md` "Read receipts" | anything else |

Shared-layer needs go in your report as **Request to <owner>: file, function, shape, why**. Devs build against the Shared API below from day 1; names are **subject to the Principal's final version** (see the placeholder note); behaviour in docs/archive/RECEIPTS_ACCEPTANCE.md is not. Rules this feature: never call `room.hasUserReadEvent` / `getReceiptsForEvent` from a component (only `src/lib/matrix/receipts.ts`); never send a receipt for a `~txn` id; never send `m.read` while the setting is OFF; never write `im.vector.web.settings` without merging the existing content; the viewer never appears in their own avatars or lists; the sender is always "seen"; test messages go in `#dev` / `#vault`, never `#general`; only QA runs Playwright (`PLAYWRIGHT_BROWSERS_PATH=/home/claude/pwb`, `E2E_WORKERS=2`); dev ports: QA 5173, Dev A 5181, Dev B 5182, Principal 5183.

## Shared API (Principal exposes; devs consume only)

Final contract (shipped; mirrored in docs/ARCHITECTURE.md "Read receipts deltas", which wins on names; docs/archive/RECEIPTS_ACCEPTANCE.md wins on behaviour).
Differences from the brief: `getSendStatus(event, myUserId)` (needs my id), `getSeenBy(holder, event | eventId, myUserId)` takes the
receipt holder from `getReceiptHolder(room, threadRootId?)`, `SeenBy` gains `notSeenCount`, `useLatestOwnSentId(source, displayedEvents)`
takes the rows too (or use `useReadPointsResult` for both values in one memo), `Reader.avatarUrl` is already an http URL (32 px),
the pure half lives in `receipts-core.ts` (re-exported by `receipts.ts`), and the e2e specs are `e2e/receipts.spec.ts` / `e2e/mobile-receipts.spec.ts`.

```ts
// src/lib/matrix/receipts-core.ts  (pure: no client, no React, no `@/`, Node-loadable; unit-tested)
type SendStatus = 'sending' | 'sent' | 'failed' | null;
interface Reader { userId: string; displayName: string; avatarUrl: string | null; ts: number }   // avatarUrl is ALREADY http (32 px crop), not mxc; ts = receipt ms, 0 if unknown
getSendStatus(event, myUserId): SendStatus          // null unless I sent it; status null | SENT -> 'sent'; NOT_SENT | CANCELLED -> 'failed'; else 'sending'
mapReadPointsToRows(orderedIds, displayedIds, points: { userId, eventId }[]): Map<rowId, userId[]>   // the hidden-event rule
pickLatestOwnSentId(displayedEvents, myUserId, readPoints): string | null   // the single "sent" check (rule below)
readSendReadReceipts(content): boolean              // default ON; only `sendReadReceipts: false` is OFF
mergeSendReadReceipts(content, on): object          // { ...content, sendReadReceipts: on }  (merge, never clobber)
RECEIPT_SETTINGS_EVENT_TYPE = 'im.vector.web.settings', SEND_READ_RECEIPTS_KEY = 'sendReadReceipts', compareReaders, sameReaders

// src/lib/matrix/receipts.ts  (SDK-bound; re-exports everything above)
type ReceiptHolder = Room | Thread;
getReceiptHolder(room, threadRootId?): ReceiptHolder | null       // main -> Room; thread -> room.getThread(root) or null until the SDK has it
buildReadPoints(holder, displayedEvents: MatrixEvent[], myUserId, { previous? }): Map<rowEventId, Reader[]>
buildReadPointsSnapshot(holder, displayedEvents, myUserId, opts?): { readPoints, latestOwnSentId }
getSeenBy(holder, event | eventId, myUserId): SeenBy              // SeenBy = { seen: Reader[]; notSeen: Reader[]; notSeenCount: number; truncated: boolean }
otherJoinedMembers(room, myUserId, exceptUserId?): RoomMember[]   // the member snapshot the two above use
isUnsentLocalEcho(event): boolean                                // `~` id, or status before SENT
getSendReadReceipts(client): boolean;  setSendReadReceipts(client, on): Promise<void>   // resolves after the /sync echo
SEEN_BY_MEMBER_LIMIT = 50, READER_AVATAR_SIZE = 32

// src/lib/matrix/actions.ts
sendReadReceipt(roomId, event | eventId, { threadId? })   // unchanged signature; sends m.read.private when the setting is OFF

// src/store/receipts.ts  (re-exported from `@/store/hooks` and `@/store`)
useReadPointsResult(source: TimelineSource | null, displayedEvents): { readPoints: Map<string, Reader[]>; latestOwnSentId: string | null }
useReadPoints(source, displayedEvents): Map<string, Reader[]>     // = .readPoints
useLatestOwnSentId(source, displayedEvents): string | null        // = .latestOwnSentId   (NOTE: takes displayedEvents too)
useSendStatus(event): SendStatus
useSeenBy(source, eventId | null): SeenBy                         // pass null while the list is closed
useSendReadReceiptsSetting(): [on: boolean, setOn: (on: boolean) => Promise<void>]
useReceiptVersion(roomId): number;  useReceiptStore  { receiptVersion: Record<roomId, number>; settingsVersion: number }
bumpReceiptVersion(roomIds), bumpReceiptSettingsVersion(), resetReceipts()   // bridge / session only

// src/app/devtools.ts  (DEV only)
__matrixPoc.receipts = { ...receipts.ts, store, getReadPoints(roomId, threadRootId?) -> { [rowId]: Reader[] },
  getLatestOwnSentId(roomId, threadRootId?), getSeenBy(roomId, eventId, threadRootId?), getSendStatus(roomId, eventId),
  getSendReadReceipts(), setSendReadReceipts(on), markRead(roomId, eventId?, threadRootId?) }
```

Rules the core implements (settled; see docs/archive/RECEIPTS_PLAN.md and the Advisor risk list):
- **Holders are never mixed.** Main rows read the `Room`'s receipts (`thread_id: 'main'` + unthreaded), thread rows the
  `Thread`'s (`thread_id: <root>`). A read point is `holder.getEventReadUpTo(userId)` (synthetic receipts included); it is
  `null` when the receipt's event is not loaded (older than the window, or a thread whose `/relations` fetch has not
  landed) -> no avatar for that user. `getSeenBy` returns the empty result when `holder.findEventById(eventId)` is null.
- **Thread root row**: inside the thread panel the root shows **no** avatars and no send status; its avatars live on its
  main-timeline row (thread receipts point at replies). `useTimeline(thread).events` already excludes the root.
- **Hidden-event rule**: the read point is attached to the nearest *displayed* row at or before it in the holder's
  unfiltered timeline (`holder.timeline`); `displayedEvents` must be the exact array the list renders.
- **Synthetic receipts are embraced**: the SDK synthesises an `m.read` for the sender of every live event, and
  `hasUserReadEvent` also counts "sent an event at or after it" and "replied in that thread" (root). So a sender's
  avatar sits on their own newest message, and someone who posts after my message counts as having seen it (Element
  behaves the same). The sender is excluded from `getSeenBy` (both lists); I am excluded everywhere.
- **Sent check** (`pickLatestOwnSentId`): the newest displayed row, when it is mine, has a `$` id, `getSendStatus` is
  `'sent'`, and `readPoints.get(id)` is empty. Otherwise null (sending indicator while `~txn`; avatars once read;
  nothing once someone else posted after it).
- **Send status** follows `event.status` through the E2EE chain `ENCRYPTING -> QUEUED/SENDING -> SENT -> null`; the id
  swaps `~txn -> $id` at `SENT`. `receiptVersion[roomId]` bumps on `Room.localEchoUpdated`, so `useSendStatus` re-reads.
- **Members**: `otherJoinedMembers` = `room.getJoinedMembers()` minus me (minus the sender for seen-by). Lazy loading means
  only senders are known until `loadMembers`; `useReadPoints` / `useSeenBy` call it and re-run on `useRoomStore.version`.
  Rooms with > 50 others: `truncated: true`, `notSeen: []`, `notSeenCount` set.
- **Re-render triggers**: `receiptVersion[roomId]` (bridge: `RoomEvent.Receipt`, `Room.localEchoUpdated`,
  `ThreadEvent.New/Update` - a Thread created later takes over the receipts the room cached for it), the displayed
  events' array identity, `useRoomStore.version` (members), `threadVersion` for thread sources. One O(members + rows)
  pass per rebuild; a row's `Reader[]` keeps its identity when unchanged (`previous` + `sameReaders`), and `Reader`
  objects are cached per room/user.
- **Private receipts**: `sendReadReceipt` is the only sender; OFF -> `ReceiptType.ReadPrivate`. Verified in the SDK:
  `sendReceipt` derives `thread_id` from the event for either type, adds the local-echo receipt, and
  `clearNotificationsOnReceipt` / `isSupportedReceiptType` accept `m.read.private`, so my unread counts clear exactly as
  with `m.read` (Synapse clears on both). My own private receipt comes back in `/sync`; others never see it. The
  setting is read live from account data (`ClientEvent.AccountData` -> `settingsVersion`), so a change made in Element
  flips the toggle without a reload; `setSendReadReceipts` spreads the existing `im.vector.web.settings` content.

| Module | Notes for consumers |
|---|---|
| `@/features/receipts` (Dev A) | `SendStatus({ status })`, `ReadAvatars({ eventId, readers, onOpen })`, `SeenByList({ source, eventId, anchor, onClose })`, `ReadReceiptsToggle()`. Dev B only maps hook results to components; Dev A owns the open / close state of the list. |
| `scripts/select-e2e.mjs` | `receipts` area: `src/features/receipts/**`, `src/store/receipts.ts` -> `e2e/receipts.spec.ts`, `e2e/mobile-receipts.spec.ts`; `receipts-core` area: `src/lib/matrix/receipts*.ts` -> the same plus CORE. Conversation files keep running the conversation area. |

---

## Principal

| ID | P | Title | Est | AC |
|---|---|---|---|---|
| PRIN-R1 | P0 | `src/lib/matrix/receipts.ts` core + `src/store/receipts.ts` hooks + bridge receipt version counter + `__matrixPoc.receipts` | 5h | AC-R1-1..4 (core half), AC-R2-1..6 (core half), AC-R3-1..5 (core half), AC-R6-1..4 (core half), AC-R10-1/2 |
| PRIN-R2 | P0 | Private receipts: `getSendReadReceipts` / `setSendReadReceipts` (account data merge), `sendReadReceipt` honours it, `useSendReadReceiptsSetting` live on `ClientEvent.AccountData` | 2h | AC-R7-1..4 (core half) |
| PRIN-R3 | P0 | `receipts` area in `scripts/select-e2e.mjs`, unit tests (`receipts.test.ts`), ARCHITECTURE "Read receipts deltas", final Shared API in this file | 2h | AC-R10-1/3/4 (area half) |

**PRIN-R1 Core** - `getSendStatus` from `event.status` (`EventStatus.SENDING` / `QUEUED` / `ENCRYPTING` -> `sending`, `NOT_SENT` -> `failed`, `null` and mine -> `sent`, not mine -> `null`). `buildReadPoints`: for each joined member except me, `receiptHolder.getReadReceiptForUserId(userId)` (room for main, `Thread` for threads), then walk the holder's timeline from that event id backwards to the first id present in `displayedEvents`; group, sort newest first. `getSeenBy` via `room.hasUserReadEvent` (thread-aware in v43), sender always seen. Hooks re-render on the bridge's receipt version for that `TimelineSource` and on the displayed events' identity. `useLatestOwnSentId`: my newest non-failed message in the timeline with zero other readers (readers computed from the same map). Verify on port 5183 against `#dev` (bob via `scripts/` API or a second browser) and against `#vault` (the `~txn` -> `$id` flip, ARCHITECTURE "do not send receipts for `~` ids"). Unit tests for the hidden-event attachment, exclusion of me, newest-first, 5 readers, truncation. Requests from devs come as "Request to Principal".

**PRIN-R2 Private receipts** - `setSendReadReceipts`: `client.getAccountData('im.vector.web.settings')?.getContent() ?? {}` spread with `{ sendReadReceipts: on }`, `client.setAccountData(...)`. `sendReadReceipt`: `client.sendReadReceipt(ev, on ? ReceiptType.Read : ReceiptType.ReadPrivate)` (check v43's signature; keep `thread_id`). `markRoomRead` / `markThreadRead` unchanged callers. Unit test: merge keeps a foreign key (AC-R7-4). Verify with the SDK that a private receipt still zeroes `getRoomUnreadNotificationCount()` after the next `/sync`.

**PRIN-R3 Area, tests, docs** - `scripts/select-e2e.test.mjs` must pass with the two new spec paths; ARCHITECTURE "Read receipts deltas" (module map, per-timeline map + version counter, hidden-event rule, main vs threaded receipts, account-data merge, the `~txn` gotcha); overwrite the Shared API section above with the final contract.

---

## Dev A - Receipts UI (`src/features/receipts/**`, new) + toggle mount

| ID | P | Title | Est | AC |
|---|---|---|---|---|
| DEV-A-R1 | P0 | `SendStatus` icon: sending (hollow circle) / sent (check) / failed wrapper, aria + title | 1h | AC-R1-1..5 (UI half), AC-R8-1 |
| DEV-A-R2 | P0 | `ReadAvatars`: stacked avatars, max 3 + `receipt-more`, hover / click / tap / keyboard open, fixed-height strip, phone 44 px | 3h | AC-R2-1..7 (UI half), AC-R5-1/3, AC-R8-1/2/3, AC-R9-3 |
| DEV-A-R3 | P0 | `SeenByList`: desktop popover / phone bottom sheet, Seen by + Not seen yet (+ empty, + truncated count), Escape / outside / backdrop close, focus return | 4h | AC-R3-1..6 (UI half), AC-R4-1 (list half), AC-R5-1/2, AC-R8-2 |
| DEV-A-R4 | P0 | `ReadReceiptsToggle` + mount in `src/app/UserFooter.tsx` (desktop and phone) | 1h | AC-R7-1/5 (UI half), AC-R5-3 |

**DEV-A-R1 SendStatus** - `components/SendStatus.tsx`: `receipt-status[data-status]`, `aria-label` / `title` "Sending…" / "Sent"; `failed` wraps the existing failed UI slot Dev B passes in (keep its testids). Small (12-14 px), trailing edge of the row, same vertical rhythm as `message-timestamp`.

**DEV-A-R2 ReadAvatars** - `components/ReadAvatars.tsx` + CSS module: `receipt-avatars[data-count][data-event-id]` with `role="group"`, `aria-label` "Seen by <names>" (3 names then "and N others"), `tabindex="0"`, Enter / Space open; `receipt-avatar[data-user-id]` (`mxcToHttp(avatarUrl, 32, 32, 'crop')`, initial fallback, `alt=""`), max 3 overlapping 18-20 px circles, `receipt-more` "+N". Fixed strip height so rows do not change height as readers come and go (AC-R9-3); phone: min 44 px tap target via padding, not layout. Hover (desktop, pointer:fine) calls `onOpen('hover')`, click / tap `onOpen('click')`; a `__dev__` harness with fake readers is fine for the 5-reader case.

**DEV-A-R3 SeenByList** - `components/SeenByList.tsx` in a portal (the list is `overflow: auto`, as `ReactionPicker`): `receipt-list[data-event-id][data-mode="popover|sheet"]` `role="dialog"` `aria-label="Seen by"`; `useIsPhone()` (`src/store/layout.ts`) picks sheet (`receipt-list-backdrop`, `aria-modal="true"`) vs popover anchored to the trigger. Sections `receipt-list-seen` ("Seen by", items newest first with `receipt-list-time` relative + `title` absolute) and `receipt-list-unseen` ("Not seen yet"); `receipt-list-empty` "Nobody has seen this yet"; `receipt-list-unseen-count` "N others haven't seen it yet" when truncated. Items `receipt-list-item[data-user-id][data-section]`, 44 px on phone. One open list at a time (module-level open state or a tiny store in the feature folder); hover-open closes on pointer leave unless pinned by click; Escape and outside click close; focus moves in on open and back to the trigger on close. Data from `useSeenBy(source, eventId)`.

**DEV-A-R4 Toggle** - `components/ReadReceiptsToggle.tsx`: `settings-send-read-receipts` `role="switch"` `aria-checked`, label "Send read receipts", hint "When off, others can't see what you've read", keyboard operable; `useSendReadReceiptsSetting()`. Mount in `UserFooter.tsx` next to `current-user` / `logout-button` (desktop footer and the phone drawer footer: same component); 44 px on phone. Export all four from `index.ts`.

---

## Dev B - Conversation (`src/features/conversation/**`)

| ID | P | Title | Est | AC |
|---|---|---|---|---|
| DEV-B-R1 | P0 | `MessageRow` / `MessageList` / `ThreadView` render `SendStatus` + `ReadAvatars` from `useReadPoints` / `useLatestOwnSentId` / `useSendStatus`, main and thread sources | 3h | AC-R1-1..4 (wiring half), AC-R2-1..6 (wiring half), AC-R6-1..3 |
| DEV-B-R2 | P0 | "Seen by" in `MessageActions` (desktop) and `MessageActionSheet` (phone), opens `SeenByList` for the row; absent on redacted rows | 1h | AC-R4-1/2, AC-R3-3, AC-R5-2 |
| DEV-B-R3 | P0 | Scroll stability: stick-to-bottom when avatars appear / move, no jump when scrolled up | 2h | AC-R9-1..3 |

**DEV-B-R1 Wiring** - In `MessageList` (main) and `ThreadView` (thread panel): `const readPoints = useReadPoints(source, displayedEvents)` and `const sentId = useLatestOwnSentId(source)` once per list, passed down; `MessageRow` renders `<SendStatus>` when `useSendStatus(event)` is non-null and (`status !== 'sent'` or `event.getId() === sentId`), and `<ReadAvatars readers={readPoints.get(event.getId())}>` when present (both inside `message-{id}`). `displayedEvents` = the same filtered list the rows render from (so hidden-event attachment in core matches the DOM). Thread rows pass the thread source; `thread-root` uses main receipts for its own avatars only if the Principal says so (default: the root row inside the panel shows **thread** readers; ask if unclear). Encrypted rooms: the row re-keys on `event.getId()` as today; verify on 5182 that `receipt-status` flips in `#vault`.

**DEV-B-R2 Seen by action** - `MessageActions.tsx`: append `message-action-seen-by` (`aria-label="Seen by"`, title "Seen by") after `message-action-delete`; `MessageActionSheet.tsx`: a "Seen by" row with the same testid. Both open `SeenByList` for the row (Dev A's `onOpen` / a small open-state API from `@/features/receipts`); the phone action sheet closes first. Not rendered for `message-redacted` rows. Check the toolbar still fits with the thread panel open (`--thread-w`); let it wrap if not, no overflow menu (Advisor consult 2).

**DEV-B-R3 Scroll** - With the list pinned, the avatar strip appearing under the newest row (replacing the check) must leave `scrollHeight - scrollTop - clientHeight < 2` (BUG-28 ResizeObserver re-pins; confirm it fires for the strip). When scrolled up, avatars moving between rows below the viewport must not move the anchor row (fixed strip height from Dev A; if a strip appears **above** the viewport, apply the Phase 4 `anchor.current` rule). Add both to your dev-server checklist; QA pins them in AC-R9-1/2.

---

## QA (`e2e/**`, `playwright.config.ts`)

| ID | P | Title | Est | AC |
|---|---|---|---|---|
| QA-R1 | P0 | `e2e/fixtures/receipts.ts`: `readAs`, `receiptRequests`, `setSendReadReceiptsViaApi`, `accountDataOf`, throwaway-room helper for "+N"; `test:e2e:receipts` | 2h | AC-R10-4 |
| QA-R2 | P0 | `e2e/receipts.spec.ts` (desktop: AC-R1, R2-1..6, R3-1..4, R4, R6, R7-1..4, R8-1/2, R9-1/2, R10-2) | 6h | as listed |
| QA-R3 | P0 | `e2e/mobile-receipts.spec.ts` (phone: AC-R5, R7-1, R8-2); regression runs (`desktop`, `mobile`); docs/BUGS.md "Read receipts"; one regression test per Wave C fix | 3h | AC-R5, AC-R10-5/6 |

**QA-R1 Fixtures** - `readAs(user, roomId, eventId, threadId?)` over `ApiUser.receipt` (plus a `readPrivateAs` posting `m.read.private` raw for AC-R3-4); `receiptRequests(page)` from `page.on('request')` filtered on `/receipt/` -> `{ types(): ('m.read' | 'm.read.private')[], last() }`; `setSendReadReceiptsViaApi(user, on)` and `accountDataOf(user, 'im.vector.web.settings')` via `e2e/fixtures/e2ee-api.ts` (`accountData`, raw `PUT`); `plusNRoom()` = `freshUser('qarcpt')` x4 + `createRoom` as alice + invite + `joinRoom` (AC-R2-4); `secondContext(browser, 'bob')` from `e2ee.ts` for the live-avatar and "bob never sees me" cases. `test:e2e:receipts` runs both specs; both join the parallel suite; serial inside the file where request counting needs it.

**QA-R2 Desktop** - AC-R1 with a delayed `**/send/**` route for `sending`, a 500 route for `failed`, and `#vault` for the encrypted flip (reuse the e2ee boot fixtures for alice's verified session); AC-R2 with bob's second context (live, no reload) and API receipts for carol / dave, reaction / edit / redaction receipts for the hidden-event rule, "+N" via `plusNRoom()`; AC-R3 / R4 hover vs click, Escape, outside click, one list at a time, the quiet-message path through `message-action-seen-by`; AC-R6 with `e2e/fixtures/threads.ts` (`rootSender: 'bob'`) and threaded vs main receipts; AC-R7 with the request listener, bob's context asserting **absence** of alice's avatar for 5 s, the foreign-key merge and the reload / API-flip; AC-R9 geometry (`boundingBox` deltas, bottom distance). Header comment: which criteria use a second browser context.

**QA-R3 Phone + runs + log** - Pixel 7: tap on avatars opens the sheet, backdrop closes, 44 px targets, long-press action sheet "Seen by", toggle reachable; full `desktop` and `mobile` at the end of Wave B and after Wave C fixes; docs/BUGS.md "Read receipts" with spec commands and the severity rule (S1: a public `m.read` while OFF, or a viewer shown as having read something they did not; S2: avatars on the wrong row, status stuck at `sending`, list jumps; S3: cosmetic).

## P0 set (the demo script works with exactly these)
PRIN-R1..R3 · DEV-A-R1..R4 · DEV-B-R1..R3 · QA-R1..R3. Total **35 h** (Principal 9 h, A 9 h, B 6 h, QA 11 h; the PM's docs are outside the estimate). Dev B can wire placeholders against the Shared API table until Dev A's `index.ts` exports exist; QA can write the API-side fixtures and the AC-R7 request assertions before any UI lands. P1 (AC-R2-4 "+N" e2e and unit, R3-5/6, R2-7, R6-4, R8-3, R9-3, R7-5): about 4 h across owners, cut in the order listed in docs/archive/RECEIPTS_ACCEPTANCE.md.
