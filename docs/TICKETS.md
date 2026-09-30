# Wave 2 Tickets

Priorities: **P0** = demo script breaks without it. P1 = demo is noticeably better. P2 = polish / stretch. Work strictly top-down inside your column. Estimates are focused hours.

## Ownership map (hard rule)
| Owner | Owns (may create/edit) | Must not edit |
|---|---|---|
| Dev A | `src/features/navigation/**` | anything else |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:e2e*` scripts in `package.json` | anything else |
| Principal | `src/app/**`, `src/store/**`, `src/lib/**`, `seed/**`, `docker/**`, `package.json`, `docs/ARCHITECTURE.md` | - |

Devs needing a shared-layer change put it in their report as **Request to Principal: file, function, shape, why**. Each feature folder exports its mountable components from its `index.ts` (`<SpaceRail/>`, `<ChannelSidebar/>`, `<ChannelHeader/>`, `<MemberPanel/>` from navigation; `<Conversation/>` from conversation); the Principal's shell mounts them in the three-column grid and passes nothing but `roomId` where needed. Feature folders may contain their own `components/`, `hooks/`, `*.module.css`. Only use CSS variables from `src/app/theme.css`.

## Shared API assumed by these tickets (Principal exposes; devs consume only)
| Module | Export | Shape |
|---|---|---|
| `src/lib/matrix/client.ts` | `getClient()` | `() => MatrixClient` (throws if not logged in) |
| | `mxcToHttp(mxc, w?, h?, method?)` | `(string, number?, number?, 'scale'|'crop'?) => string` |
| `src/store/session.ts` | `useSessionStore` | `{ status: 'logged-out'|'logging-in'|'syncing'|'ready'|'error', userId, displayName, error, login(u,p), logout() }` |
| `src/store/rooms.ts` | `useRoomStore` | `{ spaces: RoomSummary[], channelsBySpace: Record<spaceId, RoomSummary[]>, dms: RoomSummary[], selectedSpaceId: string|'home', selectedRoomId: string|null, unreadByRoom: Record<roomId, number>, selectSpace(id), selectRoom(id), version: number }` - `version` bumps on any `Room.*`/`RoomState.*`/`Room.receipt` SDK event so components re-render |
| | `RoomSummary` | `{ roomId, name, topic?, avatarUrl?, isSpace, parentSpaceId?, order?, isDm, dmUserId? }` |
| `src/store/timeline.ts` | `useTimelineStore` | `{ eventsByRoom: Record<roomId, MatrixEvent[]> (live timeline, oldest first, unfiltered), canPaginateBack: Record<roomId, boolean>, paginateBack(roomId, limit=30): Promise<void>, typingByRoom: Record<roomId, string[]> (user IDs, excludes self), version }` |
| `src/lib/matrix/actions.ts` | `sendText(roomId, body, opts?)` | `opts: { html?: string, replyTo?: MatrixEvent, mentions?: string[] } => Promise<eventId>` |
| | `editText(roomId, targetEventId, body, html?)` | `=> Promise<eventId>` (sends `m.replace`) |
| | `redactEvent(roomId, eventId)` | `=> Promise<void>` |
| | `sendReaction(roomId, targetEventId, key)` | `=> Promise<eventId>` |
| | `uploadFile(file)` | `=> Promise<{ mxc, mimetype, size, w?, h? }>` |
| | `sendFile(roomId, file)` | `=> Promise<eventId>` (`m.image` when image/*, else `m.file`) |
| | `sendTyping(roomId, typing, timeoutMs=5000)` | `=> Promise<void>` |
| | `sendReadReceipt(roomId, event)` | `=> Promise<void>` |
| | `createChannel({ spaceId, name, topic? })` | `=> Promise<roomId>` (public, unencrypted, sets `m.space.child` + `m.space.parent`) |
| | `createSpace({ name })` | `=> Promise<spaceId>` (also creates a `general` child) |
| | `inviteUser(roomId, userId)` | `=> Promise<void>` |
| | `createDm(userId)` | `=> Promise<roomId>` (reuses existing `m.direct` room, sets `m.direct`) |
| | `getJoinedMembers(roomId)`, `getInvitedMembers(roomId)` | `=> RoomMember[]` |
| | `getReactions(roomId, eventId)` | `=> { key: string, count: number, mine: boolean, senders: string[], myEventId?: string }[]` (from `timelineSet.relations`) |
| `src/lib/format.ts` | `sanitizeHtml(html)` | DOMPurify wrapper, allowlist per Matrix spec (`a strong em code pre blockquote br p ul ol li img del`), `a` gets `target=_blank rel=noopener noreferrer` |
| | `linkify(text)`, `formatTime(ts)`, `isSameDay(a,b)` | helpers |
| `src/app/theme.css` | CSS variables | per `docs/PLAN.md` |

---

## Dev A - Navigation (`src/features/navigation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-A-1 | P0 | Space rail + space switching | 4h |
| DEV-A-2 | P0 | Channel list, channel header, channel switching | 4h |
| DEV-A-3 | P0 | DM list | 3h |
| DEV-A-4 | P0 | Member list panel | 3h |
| DEV-A-5 | P0 | Unread badges (channel, DM, space) | 4h |
| DEV-A-6 | P1 | Create channel dialog | 3h |
| DEV-A-7 | P1 | Invite user to space dialog | 2h |
| DEV-A-8 | P1 | Create space dialog | 2h |
| DEV-A-9 | P2 | New DM dialog | 2h |
| DEV-A-10 | P2 | Navigation polish pass | 3h |

**DEV-A-1 Space rail + switching** - `components/SpaceRail.tsx`, `SpaceRail.module.css`. 72 px dark rail: Home button (Discord icon), divider, one round 48 px avatar/initials per space from `useRoomStore.spaces`, selected pill indicator on the left, hover tooltip (`title`), `space-add` button at the bottom. Click calls `selectSpace`. AC: AC-A1-1..5.

**DEV-A-2 Channel list + header** - `components/ChannelSidebar.tsx`, `ChannelList.tsx`, `ChannelHeader.tsx` + css. Sidebar: `space-header` with name + chevron opening `space-menu`; "TEXT CHANNELS" section with `#` items sorted by `order` then name; selected state; `channel-add`. Auto-select first channel on space change; remember last channel per space; persist `{spaceId, roomId}` to localStorage key `nav.selection`. `ChannelHeader` (column 3 top bar, mounted by shell above `<Conversation/>`): `#name`, topic, `member-toggle`. AC: AC-A2-1..5.

**DEV-A-3 DM list** - `components/DmList.tsx` + css. Shown when `selectedSpaceId === 'home'`: "DIRECT MESSAGES" section, one item per `useRoomStore.dms` with avatar/initials + display name of `dmUserId`; `dm-new` button. Header shows the other user's name when a DM is selected. AC: AC-A3-1..3.

**DEV-A-4 Member list** - `components/MemberPanel.tsx` + css. 240 px right panel: sections `ONLINE - n` (all joined members for the POC; presence is P2), `INVITED - n`; avatar/initials, display name, small crown icon for power level 100 and shield for 50. Toggle via `member-toggle` (state in the feature, default open; hidden for DMs). Re-read members on `useRoomStore.version`. AC: AC-A4-1..4.

**DEV-A-5 Unread badges** - edits to `ChannelList.tsx`, `DmList.tsx`, `SpaceRail.tsx`; `hooks/useUnread.ts`. Numeric badge (`data-count`) on channel/DM items from `unreadByRoom`; bold white name for unread rooms; rail dot when any child channel unread; badge clears when the room's count returns to 0 (Dev B sends the receipt). AC: AC-A5-1..5.

**DEV-A-6 Create channel dialog** - `components/CreateChannelDialog.tsx`, `components/Dialog.tsx` (shared modal shell inside navigation), css. Opened from `channel-add` and `space-menu-create-channel`; fields name (lowercased, spaces->dashes) and topic; calls `createChannel`, selects the new room. AC: AC-A6-1..4.

**DEV-A-7 Invite user dialog** - `components/InviteDialog.tsx`. From `space-menu-invite`; input for full user ID; calls `inviteUser` for the space **and** each child channel; shows server error text. AC: AC-A7-1..3.

**DEV-A-8 Create space dialog** - `components/CreateSpaceDialog.tsx`. From `space-add`; name only; calls `createSpace`; selects it. AC: AC-A8-1.

**DEV-A-9 New DM dialog** - `components/NewDmDialog.tsx`. From `dm-new`; user ID input; `createDm`; select room. AC: AC-A9-1.

**DEV-A-10 Polish** - hover/active states matching Discord, rail item scale-on-hover, section headers with chevrons, keyboard: Alt+Up/Down cycles channels, Escape closes dialogs, member avatars colour-hashed by user ID. No new AC; reviewed visually in the Wave 3 dry run.

---

## Dev B - Conversation (`src/features/conversation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-B-1 | P0 | Timeline rendering + sender grouping + edited/deleted display | 6h |
| DEV-B-2 | P0 | Composer: send, Enter/Shift+Enter, typing send | 3h |
| DEV-B-3 | P0 | Backwards pagination + scroll anchoring | 4h |
| DEV-B-4 | P0 | Formatted bodies (DOMPurify) + image attachments | 4h |
| DEV-B-5 | P0 | Reactions: pills, add/remove, picker | 4h |
| DEV-B-6 | P0 | Replies: quote block + composer reply state | 4h |
| DEV-B-7 | P0 | Typing indicator + read receipts | 3h |
| DEV-B-8 | P0 | File/image upload from composer | 3h |
| DEV-B-9 | P1 | Edit + delete actions | 4h |
| DEV-B-10 | P2 | @mention autocomplete | 3h |
| DEV-B-11 | P2 | Conversation polish pass | 3h |

**DEV-B-1 Timeline rendering** - `components/Conversation.tsx` (root, mounts list + composer), `MessageList.tsx`, `MessageRow.tsx`, `DayDivider.tsx`, `hooks/useRoomEvents.ts`, css. Read `eventsByRoom[roomId]`; filter to renderable events (`m.room.message`, `m.sticker`, redacted messages; drop `m.reaction`, `m.replace` relations, state events except an optional "x joined" P2); group when same sender and < 5 min gap and previous not a reply; show avatar (`mxcToHttp` 40 px crop or initials) + name + time on group start; `(edited)` when `event.replacingEvent()`; `Message deleted` when `event.isRedacted()`; day dividers; key rows by `event.getId()`; re-render on `useTimelineStore.version`; local echo styled slightly transparent until `event.status === null`. AC: AC-B1-1..8.

**DEV-B-2 Composer** - `components/Composer.tsx`, `hooks/useTyping.ts`, css. Auto-growing textarea, Enter sends via `sendText`, Shift+Enter newline, send button, disabled when blank, placeholder per room; `sendTyping(true)` throttled to every 4 s while typing, `sendTyping(false)` on send/blur/idle 5 s. AC: AC-B2-1..6.

**DEV-B-3 Pagination** - `hooks/usePagination.ts`, edits to `MessageList.tsx`. IntersectionObserver sentinel at top calls `paginateBack`; capture `scrollHeight` before and restore `scrollTop += delta` after; `timeline-loading` while in flight; `timeline-start` banner when `canPaginateBack` is false; "stick to bottom" only when within 40 px of bottom; scroll to bottom on room change. AC: AC-B3-1..4.

**DEV-B-4 Formatted bodies + images** - `components/MessageBody.tsx`, `ImageAttachment.tsx`, css. If `formatted_body` and `format === org.matrix.custom.html`: `sanitizeHtml` then `dangerouslySetInnerHTML`; else `linkify(body)` with line breaks. Rewrite `matrix.to` user links into `message-mention` pills using display names. `m.image`: thumbnail via `mxcToHttp(url, 400, 300, 'scale')`, intrinsic aspect from `info`, click opens full URL in new tab. `m.file`: download link. AC: AC-B4-1..7.

**DEV-B-5 Reactions** - `components/ReactionRow.tsx`, `ReactionPicker.tsx`, `MessageActions.tsx` (hover toolbar; shared with B-6/B-9), css. Pills from `getReactions`; click pill: mine -> `redactEvent(myEventId)`, else `sendReaction`; `reaction-add` and `message-action-react` open picker with the 6 hardcoded keys; `title` lists reactor names. AC: AC-B5-1..6.

**DEV-B-6 Replies** - `components/ReplyQuote.tsx`, edits to `Composer.tsx`, `MessageRow.tsx`; `hooks/useComposerState.ts` (reply/edit target). Quote shows author + first 120 chars of the target (looked up from timeline, fallback to fetching via `getClient().fetchRoomEvent`); `sendText(..., { replyTo })`; banner + cancel + Escape; click quote scrolls to and flashes target. AC: AC-B6-1..5.

**DEV-B-7 Typing + receipts** - `components/TypingIndicator.tsx`, `hooks/useReadReceipt.ts`. Names from `typingByRoom[roomId]` resolved via room members; send `sendReadReceipt` for the last event when the room is open, tab visible, and list at bottom (debounced 500 ms). AC: AC-B7-1..4.

**DEV-B-8 Upload** - `components/AttachButton.tsx`, `UploadProgress.tsx`, edits to `Composer.tsx`. Hidden file input, `sendFile`; progress from `uploadFile` (indeterminate is fine); paste handler for image clipboard data. AC: AC-B8-1..4.

**DEV-B-9 Edit + delete** - `components/DeleteDialog.tsx`, edits to `MessageActions.tsx`, `Composer.tsx`. Permission check via `room.currentState.maySendRedactionForEvent` / own message; edit prefills composer with `composer-edit-banner`, `editText` on Enter; ArrowUp on empty composer edits last own message; delete confirm then `redactEvent`. AC: AC-B9-1..4.

**DEV-B-10 Mention autocomplete** - `components/MentionAutocomplete.tsx`, `hooks/useMentions.ts`. `@` trigger, filter joined members, arrow keys/Enter/Escape, inserts display name and records `{ userId, text }` so send builds `formatted_body` + `m.mentions`. AC: AC-B10-1..3.

**DEV-B-11 Polish** - hover background on rows, timestamp on hover for grouped rows, "New messages" divider on unread boundary, smooth scroll-to-bottom button, image fade-in, emoji-only messages rendered large. No new AC.

---

## QA (`e2e/**`, `playwright.config.ts`)

| ID | P | Title | Est |
|---|---|---|---|
| QA-1 | P0 | Playwright scaffold, fixtures, `npm run test:e2e` | 3h |
| QA-2 | P0 | Matrix API helper for second-user actions | 3h |
| QA-3 | P0 | Smoke test = demo script | 4h |
| QA-4 | P1 | Navigation suite (AC-A*) | 4h |
| QA-5 | P1 | Conversation suite (AC-B*) | 5h |
| QA-6 | P1 | Bug report format + `docs/BUGS.md` | 1h |
| QA-7 | P2 | `test:e2e:fresh` (reset + seed + run) and flake pass | 2h |

**QA-1 Scaffold** - `playwright.config.ts` (baseURL `http://localhost:5173`, Chromium only, `screenshot: 'only-on-failure'`, `trace: 'retain-on-failure'`, `video: 'retain-on-failure'`, output `e2e/results/`, `webServer` starting `npm run dev` with `reuseExistingServer: true`, 30 s test timeout), `e2e/fixtures/auth.ts` (`loginAs(page, 'alice')`), `e2e/fixtures/seed.ts` (reads `seed/seed-output.json`; resolves aliases via `GET /_matrix/client/v3/directory/room/{alias}` as fallback), `e2e/fixtures/test-image.png`, `e2e/shell.spec.ts` covering AC-SH-1..5. Adds `test:e2e`, `test:e2e:headed`, `test:e2e:ui` scripts (report as a Request to Principal for `package.json`; QA may edit only those script lines).

**QA-2 API helper** - `e2e/fixtures/matrix-api.ts`: `asUser('bob')` -> `{ send(roomId, body, extra?), sendHtml, react(roomId, eventId, key), typing(roomId, on), redact(roomId, eventId), receipt(roomId, eventId), getReceipts(roomId, eventId), getEvent(roomId, eventId), hierarchy(spaceId), invite, joinedMembers }` on raw `fetch`, token cached per user, retries on 429. Used by every live-update criterion.

**QA-3 Smoke test** - `e2e/smoke.spec.ts`: one serial spec that walks `docs/PLAN.md` demo steps 1-10 in order as alice, using bob via QA-2 for step 9; asserts each "should see" column; takes a full-page screenshot per step into `e2e/results/demo/` even on success (they are the stakeholder pre-read). Must pass before the Wave 3 dry run.

**QA-4 Navigation suite** - `e2e/navigation.spec.ts` covering AC-A1..A9. Creation tests use unique names (`memes-${Date.now()}`) so re-runs on the same seed pass.

**QA-5 Conversation suite** - `e2e/conversation.spec.ts` covering AC-B1..B10, including the XSS payload (AC-B4-4), redaction (AC-B1-6), and receipt verification (AC-B7-3) through the API helper.

**QA-6 Bug report format** - `docs/BUGS.md` with a header table and this row template: `| BUG-n | AC ref | Sev (S1 blocks demo / S2 wrong but demo works / S3 cosmetic) | Owner | Steps (numbered, from fresh seed) | Expected | Actual | Screenshot/trace path | Status |`. Every failing test during Wave 3 gets a row; devs close rows with the commit.

**QA-7 Fresh run** - `test:e2e:fresh` = `npm run seed:reset && npm run test:e2e`; run the full suite 3x and fix any flake (prefer `expect.poll` and testid waits over sleeps; forbid `waitForTimeout`).

## P0 set (demo works with exactly these)
DEV-A-1, A-2, A-3, A-4, A-5 · DEV-B-1, B-2, B-3, B-4, B-5, B-6, B-7, B-8 · QA-1, QA-2, QA-3. Total 59 h (A 18 h, B 31 h, QA 10 h). Dev B is the critical path; if B slips, Dev A picks up DEV-B-8 then DEV-B-7 after finishing A-5 (still inside `src/features/conversation/**`, coordinate file names via STATUS notes).
