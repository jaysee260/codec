# Architecture (source of truth for the shared layer)

This document is the contract between the Principal-owned core (`src/lib`, `src/store`, `src/app`,
`seed`, `scripts`, `homeserver`) and the feature owners. Where it differs from
`docs/TICKETS.md` "Shared API", **this file wins**; the differences are listed first.

## Deltas from TICKETS.md "Shared API"

| Topic | TICKETS.md says | What is actually shipped | Why |
|---|---|---|---|
| Homeserver folder | `docker/**` | `homeserver/**`: `homeserver/homeserver.yaml` is the single Synapse config, used by `homeserver/docker-compose.yml` (Docker) and by the WSL1 fallback in `homeserver/wsl/` (for machines without virtualization). `npm run hs:*` picks the backend automatically. | Orchestrator brief + this machine has no virtualization. |
| `useSessionStore` | `{ status, userId, displayName, error, login, logout }` | Same, plus `avatarUrl`, `syncState`, `register(u,p)`, `restore()`. `status` values are exactly `'logged-out' \| 'logging-in' \| 'syncing' \| 'ready' \| 'error'`. | Register toggle on the login screen; page-load restore. |
| `useRoomStore` | `{ spaces, channelsBySpace, dms, selectedSpaceId, selectedRoomId, unreadByRoom, selectSpace, selectRoom, version }` | Same, plus `roomsById`, `orphanRooms`, `invites`, `highlightByRoom`, `lastRoomBySpace`, `ready`. **The store already auto-selects the first channel on space change, remembers the last channel per space and persists `nav.selection` to localStorage** (DEV-A-2 need not implement that; just call `selectSpace` / `selectRoom`). First-ever load lands on the first space (alphabetical), i.e. Acme HQ / #general. | Keeps selection logic in one place, testable, and identical for QA fixtures. |
| `RoomSummary` | `{ roomId, name, topic?, avatarUrl?, isSpace, parentSpaceId?, order?, isDm, dmUserId? }` | Same fields plus `canonicalAlias?`, `joinRule`, `membership`, `lastActiveTs`, `memberCount`, `unread`, `highlight`. | Superset; nothing renamed. |
| `useTimelineStore` | `{ eventsByRoom, canPaginateBack, paginateBack(roomId, limit=30), typingByRoom, version }` | Same, plus `isPaginating: Record<roomId, boolean>`. `paginateBack` also refreshes the snapshot before resolving. Hooks `useRoomTimeline`, `useTyping`, `useMembers` are provided on top (optional). | Pagination UI needs the in-flight flag. |
| `mxcToHttp` | exported from `src/lib/matrix/client.ts` | Exported from `client.ts` **and** `src/lib/matrix/mxc.ts` (pure, no client needed) and `utils.ts`. Signature `(mxc, w?, h?, method?: 'scale' \| 'crop') => string` ('' for non-mxc input). | Usable before login (avatars in the login footer, tests). |
| `sendText` opts | `{ html?, replyTo?: MatrixEvent, mentions? }` | `replyTo` accepts `MatrixEvent \| string` (event id). | Convenience. |
| `createSpace` | `({ name })` | `({ name, topic? })`; still auto-creates `general`. | Superset. |
| Extra actions | - | `toggleReaction`, `markRoomRead`, `joinRoom`, `leaveRoom`, `loadMembers`, `fetchEvent`, `canRedactEvent`, `canEditEvent`, `myPowerLevel`, `findDmRoomId`, `getDirectMap`. | Needed by the placeholders / dialogs; documented below. |
| Feature components | navigation exports `SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel`; conversation exports `Conversation` | Exactly that, plus navigation exports `useNavUiStore` (member panel open/closed) which Dev A owns. `ChannelSidebar` renders `DmList` itself when `selectedSpaceId === 'home'`. | Matches TICKETS; the DM list is an internal component of Dev A's folder. |
| Rate limits | PLAN says `per_second: 1000, burst_count: 1000` | Exactly that, for `rc_message`, `rc_registration`, `rc_login.*`, `rc_joins.*`, `rc_joins_per_room`, `rc_invites.*`, `rc_presence`, `rc_media_create`, `rc_admin_redaction`. | - |
| Seed location | `seed/seed.ts`, output `seed/seed-output.json` | Same. The orchestrator brief said `scripts/seed.ts`; SEED_DATA.md wins. | - |
| Room version | not specified | `createChannel` / `createSpace` / `createDm` and the seed pin `room_version: "11"`. Synapse >= 1.162 defaults to v12, where the creator has "infinite" power and must not appear in `power_level_content_override.users`; v11 keeps alice at an explicit 100 (crown icon, `myPowerLevel()`), matching SEED_DATA.md. | Contract says alice = 100. |
| Redacted messages in the timeline | TICKETS DEV-B-1 renders them as "Message deleted" | `isDisplayableEvent()` **keeps** redacted `m.room.message` events so Dev B can render `message-redacted`. | - |
| Timestamps | AC-B1-8 | `formatTime(ts)` returns `HH:MM` for today and `DD/MM/YYYY HH:MM` otherwise. | - |

## Module map

```
src/
  main.tsx                     React root; imports styles/global.css
  app/                         (Principal) session gate + shell
    App.tsx                    status -> LoginScreen | LoadingScreen | Shell
    LoginScreen.tsx            login/register form
    LoadingScreen.tsx          data-testid=app-loading until PREPARED
    Shell.tsx                  72 | 240 | 1fr | auto grid, mounts feature components
    UserFooter.tsx             bottom-left user pill + logout
    Toast.tsx                  global toasts
    theme.css                  design tokens (the only CSS variables features may use)
  styles/global.css            reset, scrollbars, utilities (.u-avatar, .u-btn, .u-input, ...)
  lib/
    format.ts                  sanitizeHtml, linkify, formatTime, isSameDay, formatDayDivider, initialsOf, colorFor
    matrix/
      config.ts                HS_URL, storage keys, localpartOf, serverNameOf
      mxc.ts                   mxcToHttp (pure)
      client.ts                getClient, login, register, logout, session persistence, startClient
      actions.ts               every write + a few aggregate readers (members, reactions)
      utils.ts                 read helpers over SDK objects (display names, avatars, getDisplayBody, ...)
  store/
    session.ts                 useSessionStore
    rooms.ts                   useRoomStore + recomputeRooms + waitForRoom
    timeline.ts                useTimelineStore + refreshTimeline + setTypingForRoom
    bridge.ts                  bindClient/unbindClient: SDK events -> stores (debounced)
    hooks.ts                   useRoomTimeline, useTyping, useMembers, useRoomSummary, useSelectedRoom, useMyUserId
    toast.ts                   useToastStore, showToast, withToast
    index.ts                   re-exports
  features/
    navigation/                (Dev A) index.ts exports SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel, useNavUiStore
    conversation/              (Dev B) index.ts exports Conversation
seed/seed.ts                   fixture script (docs/SEED_DATA.md), writes seed/seed-output.json
scripts/hs.mjs                 homeserver wrapper: up/down/reset/logs/status over docker compose OR homeserver/wsl/hs.sh
scripts/verify-scaffold.mjs    throwaway Playwright smoke (login + screenshot)
homeserver/                    homeserver.yaml (single config, committed), docker-compose.yml, wsl/ (no-Docker fallback), data/* (ignored)
e2e/, playwright.config.ts     (QA)
```

## Ownership

| Owner | Owns | Must not edit |
|---|---|---|
| Principal | `src/app/**`, `src/store/**`, `src/lib/**`, `src/styles/**`, `seed/**`, `scripts/**`, `homeserver/**`, `package.json`, `docs/ARCHITECTURE.md`, root configs | - |
| Dev A | `src/features/navigation/**` | anything else |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:e2e*` script lines in `package.json` | anything else |

**Requesting a change to the core layer**: do not edit it. Put a block in your final report:
`Request to Principal: <file>, <function/hook>, <desired shape>, <why>`. The Principal implements it
(usually within the same wave) and updates this document. Small, additive requests (a new reader in
`actions.ts`, an extra field on `RoomSummary`) are cheap; changes to store shapes are not.

The shell mounts feature components and passes nothing but `roomId`:

```tsx
<SpaceRail />                       // column 1
<ChannelSidebar />  <UserFooter />  // column 2 (UserFooter is Principal's)
<ChannelHeader roomId={id} />       // column 3 top
<Conversation roomId={id} />        // column 3 rest
<MemberPanel roomId={id} />         // column 4; return null to hide (the grid column collapses)
```

## Runtime model

1. `App` mounts -> `useSessionStore.restore()`. If localStorage has a session (`matrix-poc.session`
   = `{ baseUrl, userId, accessToken, deviceId }`) the store starts in `'syncing'`; otherwise `'logged-out'`.
2. `login()`/`register()`/`restore()` -> `startClientFromSession()` creates the `MatrixClient`
   (`createClient` with `timelineSupport: true`, **no crypto**), calls
   `startClient({ initialSyncLimit: 30, lazyLoadMembers: true, pendingEventOrdering: 'chronological', threadSupport: false })`,
   then `bindClient()` subscribes the bridge, then `waitForPrepared()` resolves on `SyncState.Prepared`.
   Status becomes `'ready'` and the shell renders. The bridge does one full `recomputeRooms()` +
   `refreshTimelines(all rooms)` at PREPARED and again whenever the SDK goes ERROR -> SYNCING (catch-up).
3. From then on every SDK event lands in a store through the bridge with a 50 ms (rooms) / 30 ms
   (timelines) trailing debounce. React re-renders once per burst, never once per event.
4. `logout()` -> server logout (best effort), `stopClient()`, listeners removed, localStorage cleared,
   stores reset. Token revoked server-side (`HttpApiEvent.SessionLoggedOut`) triggers the same.

## Store / hook / action API

### `useSessionStore` (`src/store/session.ts`)

| Member | Type | Semantics |
|---|---|---|
| `status` | `'logged-out' \| 'logging-in' \| 'syncing' \| 'ready' \| 'error'` | See runtime model. `'error'` = last login/register failed; the login form shows `error`. |
| `userId` | `string \| null` | `@alice:localhost` |
| `displayName`, `avatarUrl` | `string \| null` | From `/profile` after PREPARED (`avatarUrl` is an mxc). |
| `error` | `string \| null` | Human-readable; also set while `'ready'` if sync errors (shell shows "Reconnecting"). |
| `syncState` | `SyncState \| null` | Raw SDK sync state. |
| `login(username, password)` | `Promise<void>` | Never throws; failure -> `status: 'error'` + `error`. |
| `register(username, password)` | `Promise<void>` | Open registration via `m.login.dummy`; logs in on success. |
| `logout()` | `Promise<void>` | Never throws. |
| `restore()` | `Promise<void>` | Page-load restore. Idempotent. |

`describeError(e)` maps `MatrixError`/network errors to friendly text.

### `useRoomStore` (`src/store/rooms.ts`)

| Member | Type | Semantics |
|---|---|---|
| `ready` | `boolean` | True after the first recompute post-PREPARED. |
| `spaces` | `RoomSummary[]` | Joined `m.space` rooms, sorted by name. |
| `channelsBySpace` | `Record<spaceId, RoomSummary[]>` | Joined child rooms per space, sorted by `m.space.child.order` then name. Children I have not joined are not listed (request `getRoomHierarchy` support if needed). |
| `dms` | `RoomSummary[]` | Rooms listed in my `m.direct` account data, newest activity first. |
| `orphanRooms` | `RoomSummary[]` | Joined rooms with no space and not DMs (shown under Home). |
| `invites` | `RoomSummary[]` | Rooms I am invited to. |
| `roomsById` | `Record<roomId, RoomSummary>` | Every joined/invited room. |
| `unreadByRoom`, `highlightByRoom` | `Record<roomId, number>` | From `room.getUnreadNotificationCount()` (server-computed; updates after receipts sync back). |
| `selectedSpaceId` | `string \| 'home'` | `'home'` = DM view. |
| `selectedRoomId` | `string \| null` | |
| `lastRoomBySpace` | `Record<spaceId \| 'home', roomId>` | Persisted with the selection under localStorage `nav.selection`. |
| `version` | `number` | Bumps on every recompute. Subscribe to it to re-read SDK objects (members, power levels). |
| `selectSpace(id)` | `void` | Switches space and selects its remembered or first channel (DMs for `'home'`). Persists. Kicks off `loadMembersIfNeeded`. |
| `selectRoom(roomId \| null)` | `void` | Selects a room and switches `selectedSpaceId` to its space (`'home'` for DMs/orphans). Persists. |

Helpers: `recomputeRooms()` (bridge only), `resetRooms()`, `waitForRoom(roomId, timeoutMs=8000): Promise<boolean>`
(resolves once a freshly created room arrives via sync; use after `createChannel`/`createSpace`/`createDm` before selecting).

`RoomSummary`:
```ts
{ roomId, name, topic?, avatarUrl?, canonicalAlias?, isSpace, parentSpaceId?, order?, isDm, dmUserId?,
  joinRule, membership, lastActiveTs, memberCount, unread, highlight }
```
`name` is the bare room name (`general`, not `#general`); for DMs it is the other user's display name.

### `useTimelineStore` (`src/store/timeline.ts`)

| Member | Type | Semantics |
|---|---|---|
| `eventsByRoom` | `Record<roomId, MatrixEvent[]>` | Copy of `room.getLiveTimeline().getEvents()`, oldest first, **unfiltered** (state events, reactions, edits, local echoes included). New array identity per change. |
| `canPaginateBack` | `Record<roomId, boolean>` | `false` once the room start is reached (no backward pagination token). Missing = unknown, treat as `true`. |
| `isPaginating` | `Record<roomId, boolean>` | |
| `typingByRoom` | `Record<roomId, string[]>` | User ids typing, excluding me. |
| `version` | `number` | Bumps on every timeline/typing commit. |
| `paginateBack(roomId, limit=30)` | `Promise<void>` | `client.paginateEventTimeline(liveTimeline, { backwards: true, limit })`, then refreshes the snapshot. No-op while in flight or at the start. |

Helpers: `refreshTimeline(roomId)`, `refreshTimelines(ids)`, `ensureTimeline(roomId)`, `setTypingForRoom`, `resetTimelines`.

### Hooks (`src/store/hooks.ts`)

| Hook | Returns | Notes |
|---|---|---|
| `useRoomTimeline(roomId)` | `{ events, allEvents, hasMore, isPaginating, version, paginateBack(limit?) }` | `events` = `allEvents.filter(isDisplayableEvent)` (messages + stickers, incl. redacted; no reactions/edits/state). Calls `ensureTimeline`. |
| `useTyping(roomId)` | `string[]` | Display names of typing users (never me). |
| `useMembers(roomId)` | `{ joined: MemberInfo[], invited: MemberInfo[] }` | Sorted by power level desc then name; triggers `loadMembers`. `MemberInfo = { userId, name, avatarUrl, powerLevel, membership, presence }`. |
| `useRoomSummary(roomId)` | `RoomSummary \| undefined` | |
| `useSelectedRoom()` | `RoomSummary \| undefined` | |
| `useMyUserId()` | `string \| null` | |

### Actions (`src/lib/matrix/actions.ts`)

| Function | Signature | Semantics |
|---|---|---|
| `sendText` | `(roomId, body, opts?: { html?, replyTo?: MatrixEvent \| string, mentions?: string[] }) => Promise<eventId>` | `m.text`; `html` -> `formatted_body`; `replyTo` -> `m.relates_to.m.in_reply_to`; `mentions` -> `m.mentions.user_ids`. Local echo appears immediately. |
| `editText` | `(roomId, targetEventId, body, html?) => Promise<eventId>` | Sends `m.replace` with `m.new_content` and `* ` fallback body. |
| `redactEvent` | `(roomId, eventId, reason?) => Promise<void>` | Messages, reactions, anything. |
| `sendReaction` | `(roomId, targetEventId, key) => Promise<eventId>` | `m.reaction` / `m.annotation`. |
| `toggleReaction` | `(roomId, targetEventId, key) => Promise<void>` | Adds, or redacts my existing reaction with that key. |
| `uploadFile` | `(file: File) => Promise<{ mxc, mimetype, size, name, w?, h? }>` | Media upload; image dimensions measured in the browser. |
| `sendFile` | `(roomId, file) => Promise<eventId>` | `m.image` for `image/*` (with `info.w/h`), else `m.file`. |
| `sendTyping` | `(roomId, typing, timeoutMs=5000) => Promise<void>` | |
| `sendReadReceipt` | `(roomId, event: MatrixEvent \| eventId) => Promise<void>` | `m.read`. Skips local echoes. |
| `markRoomRead` | `(roomId) => Promise<void>` | Receipt for the newest sent event in the live timeline. |
| `createChannel` | `({ spaceId, name, topic? }) => Promise<roomId>` | `preset: public_chat`, `visibility: private`, unencrypted, `m.space.parent` on the room, `m.space.child` (next `order`) on the space. |
| `createSpace` | `({ name, topic? }) => Promise<spaceId>` | `m.space`, public preset, then `createChannel({ name: 'general' })`. |
| `inviteUser` | `(roomId, userId) => Promise<void>` | Throws `MatrixError` (e.g. unknown user). |
| `createDm` | `(userId) => Promise<roomId>` | Reuses a joined room from `m.direct`; else `is_direct` + `trusted_private_chat` + invite, and updates `m.direct`. |
| `findDmRoomId`, `getDirectMap` | sync | `m.direct` readers. |
| `joinRoom` | `(roomIdOrAlias) => Promise<roomId>` | |
| `leaveRoom` | `(roomId) => Promise<void>` | |
| `getJoinedMembers`, `getInvitedMembers` | `(roomId) => RoomMember[]` | Sync readers (lazy-loaded; see `loadMembers`). |
| `loadMembers` | `(roomId) => Promise<void>` | `room.loadMembersIfNeeded()`; the store `version` bumps when they arrive. |
| `getReactions` | `(roomId, eventId) => { key, count, mine, senders, myEventId? }[]` | From `timelineSet.relations`; safe in render. |
| `fetchEvent` | `(roomId, eventId) => Promise<MatrixEvent \| undefined>` | Local timeline first, then `/rooms/{id}/event/{eventId}`. For reply quotes whose target is not loaded. |
| `canRedactEvent` | `(roomId, event) => boolean` | `room.currentState.maySendRedactionForEvent`. |
| `canEditEvent` | `(event) => boolean` | Own, non-redacted `m.room.message`. |
| `myPowerLevel` | `(roomId) => number` | |

### Read helpers (`src/lib/matrix/utils.ts`)

`displayNameOf(room, userId)`, `avatarUrlOf(room, userId, size=40)`, `memberAvatarUrl(member, size)`,
`roomAvatarUrl(room, size)`, `roomTopic(room)`, `isEditEvent(e)`, `isReactionEvent(e)`, `isDisplayableEvent(e)`,
`getReplyTargetId(e)`, `stripReplyFallback(body)`, `stripHtmlReplyFallback(html)`, `previewText(e, max)`,
`isPendingEvent(e)`, and

```ts
getDisplayBody(event) => { text, html?, msgtype, isEdited, isRedacted, replyTo?, url?, info?, mentions }
```
`text`/`html` already reflect the latest edit (the SDK swaps `getContent()` when the `m.replace` arrives) and have
legacy reply fallbacks stripped. Sanitise `html` with `sanitizeHtml()` from `src/lib/format.ts` before rendering.

### Formatting (`src/lib/format.ts`)

`sanitizeHtml(html)` (DOMPurify, Matrix allowlist, `<a target=_blank rel=noopener noreferrer>`, `<img>` only from mxc),
`linkify(text) => ({ kind: 'text' } | { kind: 'link', href })[]`, `escapeHtml`, `formatTime(ts)`, `formatFullTime(ts)`,
`formatDayDivider(ts)`, `isSameDay(a, b)`, `initialsOf(name)`, `colorFor(id)`.

### Client (`src/lib/matrix/client.ts`)

`getClient()` (throws when logged out), `getClientOrNull()`, `loadSession/saveSession/clearSession`,
`login`, `register`, `startClientFromSession`, `waitForPrepared`, `logout`, `mxcToHttp` (re-export).
`HS_URL` comes from `VITE_HS_URL` (default `http://localhost:8008`).

## data-testid convention

`data-testid`, kebab-case, `{area}-{element}`; dynamic suffix is the raw Matrix id (`channel-item-!abc:localhost`,
`message-$xyz`, `member-item-@bob:localhost`, `reaction-👍`). Helper attributes: `data-name` (room/user display name),
`data-sender`, `data-count`, `data-mine`, `data-selected`. The full registry is `docs/ACCEPTANCE.md`; the
Principal-owned ids are `login-form`, `login-username`, `login-password`, `login-submit`, `login-register-toggle`,
`login-error`, `app-loading`, `app-shell`, `current-user`, `logout-button`, `toast`, `empty-state`.
The placeholder feature components already use the registry ids (`space-rail`, `channel-item-*`,
`message-list`, `composer-input`, ...); keep them when replacing internals.

## How to run everything

```
npm install            # + Playwright chromium (postinstall)
npm run hs:up          # Synapse on :8008 (Docker if available, else the WSL1 fallback; see homeserver/README.md)
npm run seed           # fixture data; idempotent guard on #acme-hq:localhost; writes seed/seed-output.json
npm run dev            # Vite on :5173
npm run typecheck      # tsc --noEmit
npm run build          # tsc + vite build
npm run test:e2e       # Playwright (starts the dev server if needed)
npm run seed:reset     # wipe the homeserver data and reseed
node scripts/verify-scaffold.mjs   # login as alice + screenshot to docs/screenshots/scaffold.png
```

`.env` (optional): `VITE_HS_URL=http://localhost:8008`. The seed and scripts read `HS_URL`. Nothing in the client,
seed or tests depends on how the homeserver is hosted - only on that URL.

## matrix-js-sdk gotchas (v43) you must know

- **Edits**: the `m.replace` event is in the timeline too. Never render it as a row (`isDisplayableEvent` drops it).
  The target's `getContent()` already returns `m.new_content`; `event.replacingEvent()` is non-null when edited.
  The target object is mutated in place, so a memoised row keyed only on `event.getId()` will not re-render:
  include `useRoomTimeline().version` (or `event.replacingEventId()`) in your memo deps.
- **Reactions**: also timeline events; aggregated in `room.getUnfilteredTimelineSet().relations`. Use
  `getReactions(roomId, eventId)`; it re-reads on every render, and the list re-renders on `version`.
- **Redactions**: the event stays in the timeline with empty content, `event.isRedacted()` true. Redacted
  reactions disappear from `getReactions`.
- **Local echo**: `sendText` puts a pending event (id `~...`, `event.status !== null`) in the live timeline
  immediately; when the server acks, `Room.localEchoUpdated` fires and the id changes to `$...`. Key rows by
  `event.getId()` and expect one re-render with a new key. Do not send receipts for `~` ids (`sendReadReceipt` guards).
- **Ordering / pagination**: `paginateBack` prepends into the same live `EventTimeline`; the snapshot is
  replaced wholesale (oldest first). Pin the scroll position around it (DEV-B-3). A `Room.timelineReset`
  (sync gap) replaces the array too; treat every commit as "re-render from the array", never diff manually.
- **Lazy members**: only senders are known after the initial sync. `useMembers`/`selectRoom` call
  `loadMembersIfNeeded`; the member list fills in on the next `version` bump. Typing users are read from the
  `m.typing` event's `user_ids`, so unknown members still show (as their localpart until loaded).
- **Unread counts** are server-side (`unread_notifications`). After `sendReadReceipt` the badge clears when the
  next `/sync` echoes the receipt (usually < 1 s). The seed leaves #random at 3 and #lobby at 2 for alice.
- **Media**: the homeserver runs with `enable_authenticated_media: false`, so `mxcToHttp()` returns plain
  `/_matrix/media/v3/{download,thumbnail}` URLs that work in `<img>` without headers. Do not switch this on.
- **No crypto**: never call `initRustCrypto`; rooms are created without `m.room.encryption`. Encrypted rooms from
  other clients would show as undecryptable - out of scope.
- **Sync loop errors**: the SDK retries forever; `useSessionStore.error` carries the message while `status`
  stays `'ready'`. `UserFooter` shows "Reconnecting...".
- `MatrixError` (from `matrix-js-sdk`) has `errcode` and `httpStatus`; `describeError()` gives user text.
- **Expected console 404 on startup**: the SDK probes `/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`
  (MatrixRTC) once per `startClient`; Synapse answers 404. Harmless, ignore it in QA console checks.
- **Initial window**: `initialSyncLimit: 30` counts every event (reactions, edits, state), so #general shows ~25
  message rows before the first `paginateBack`; `general.first` is not in the DOM until you paginate (AC-B3-1).
