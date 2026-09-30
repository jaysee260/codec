# Bug log

QA owns this file (docs/TICKETS.md QA-6). Every failing test during Wave 3 gets a row; devs close a
row with the commit that fixes it (put the commit sha in **Status**).

**Severity** — `S1` blocks the demo script in docs/PLAN.md · `S2` wrong but the demo still works ·
`S3` cosmetic.

**Reproducing** — steps are written from a fresh seed:

```
npm run hs:up && npm run seed:reset && npm run dev     # homeserver + fixtures + client
npm run test:e2e                                        # whole suite
npx playwright test e2e/conversation.spec.ts -g "AC-B3-2"   # one criterion
npx playwright show-trace e2e/results/<test-dir>/trace.zip  # the trace named in the row
```

Artefacts live under `e2e/results/<test-dir>/` (failure screenshot, trace, video) and
`e2e/results/demo/` (one full-page screenshot per demo step, written even when green).

| BUG | AC ref | Sev | Owner | Steps (from fresh seed) | Expected | Actual | Screenshot/trace | Status |
|---|---|---|---|---|---|---|---|---|
| BUG-1 | AC-B5-3, AC-B5-4, AC-B1-1, demo step 5 | S1 | Dev B | 1. Log in as alice. 2. Page `#general` back to the beginning. 3. Hover bob's "Lunch today? Thinking tacos." (`general.reacted`). 4. Click `message-action-react`, pick 🎉. 5. Click the new `reaction-🎉` pill to remove it. | The pill is clickable and the reaction is redacted. | Click times out: *"`<span data-testid="message-timestamp">` from `<div data-testid="message-$Yl6…">` subtree intercepts pointer events"*. Root cause: `MessageList.module.css .list` was `display:flex; flex-direction:column`, so every row was a flex item with the default `flex-shrink:1`; combined with `MessageRow.module.css .row { min-height:22px }` (an explicit min-height overrides the automatic minimum size) the flex algorithm shrank **every** row to 22 px while its content stayed 34 px+. Measured: `clientHeight 580 / scrollHeight 978`, all 24 rows `height 22px`, `flex-shrink 1`, content overflowing. Rows therefore painted over each other and the *following* row won hit-testing on pills, quotes and images. | `e2e/results/smoke-demo-script-QA-3-smo-8c4a7-oday-message-then-remove-it-chromium/` (trace.zip + test-failed-1.png) | **Fixed** by Dev B during Wave 2 — `.list` is no longer a flex container and `.row` sets `flex-shrink: 0`. Re-verified: AC-B5-1..B5-6 and demo step 5 pass. |
| BUG-2 | AC-B3-2 | S2 | Dev B | 1. Log in as alice (`#general` opens). 2. Note the top-most rendered row and its viewport `y`. 3. Scroll `message-list` to the top so backwards pagination fires. 4. When the older messages have rendered, measure that same row's viewport `y` again. | DEV-B-3: capture `scrollHeight` before `paginateBack` and restore `scrollTop += delta` after, so the anchor row stays at the same viewport position (criterion allows no jump). | The anchor row moved **~545-582 px** down the viewport — the list kept `scrollTop` while ~30 events were prepended, throwing the reader out of position on every page-in. `timeline-loading` did appear and the older messages did load, so the demo's "scroll to the top" still worked; only the anchoring was missing. | `e2e/results/conversation-DEV-B-3-backw-f00e8-er-messages-without-jumping-chromium/` (trace.zip + test-failed-1.png) | **Fixed** by Dev B during Wave 2. Re-verified: AC-B3-2 passes, anchor drift now ≤ 5 px. |
| BUG-3 | AC-A6-2, AC-A8-1, demo step 10 | S1 | Principal | 1. `npm run test:e2e` (or `npx playwright test e2e/navigation.spec.ts e2e/smoke.spec.ts`) — the failure needs a *loaded* homeserver, it does not reproduce running one test alone (`-g "AC-A6-2" --repeat-each=3` is 3/3 green). 2. Watch the create-channel / create-space criteria. | `create-channel-dialog` closes, the new room appears in `channel-list` with its `data-name`, selected, topic in the header. | The dialog closes (so `createChannel`/`createSpace` resolved server-side and the room exists) but the item **never appears in `channel-list`** within 15-20 s: *"element(s) not found"*. Intermittent and it moves between criteria — one run failed AC-A6-2 + step 10, the next passed AC-A6-2 and failed AC-A8-1 + step 10. Always a *newly created* room, never a seeded one, so the suspicion is the freshly-created room not reaching `useRoomStore.channelsBySpace` (`waitForRoom` / `recomputeRooms` missing the sync that carries it) rather than the sidebar render. Blocks demo step 10, hence S1. `expectChannelListed()` in `e2e/navigation.spec.ts` now records what the sidebar actually held, which separates "room never arrived" from "arrived without its name". | `e2e/results/navigation-DEV-A-6-creat-*-chromium/` and `e2e/results/smoke-*-step-10-*/` (trace.zip); look for the `diagnostic` annotation in the HTML report | **Fixed** (Principal). Two layers: (a) Synapse's separate `rc_room_creation` limiter (default burst 10, then 1/min per user) had not been relaxed, so after hours of test runs `createRoom` returned 429 and the dialog showed an error; (b) the store selected the new room from the first `/sync` batch (create + join only) before `m.space.parent` arrived in the next batch, so the selection flipped to Home. Fix: `retryOnRateLimit` honouring `retry_after_ms` (30 s budget) around `createChannel`/`createSpace`/`createDm`/`inviteUser`/`joinRoom` in `src/lib/matrix/actions.ts`; a selection invariant plus pending selection in `src/store/rooms.ts`; `rc_room_creation: 1000/1000` in `homeserver/homeserver.yaml`, `scripts/hs.mjs` and `homeserver/wsl/configure.sh` (applies on the next homeserver restart; until then alice's room creation is still ~1/min after a burst of 10). Re-verified: AC-A6 / AC-A8 / AC-A1 groups 9/9 pass. |

## Not bugs — criteria that cannot be judged on a dirty homeserver

These are skipped with an actionable reason by `e2e/fixtures/fresh.ts`, not failed. They need
`npm run test:e2e:fresh` (seed reset + run). See the fixture header for why each one is
seed-sensitive.

| Criterion | Why it needs a fresh seed |
|---|---|
| AC-B1-1, AC-B3-1 | Assert which rows are inside the initial ~30-event sync window; every message anyone sends into `#general` pushes the seeded rows out of it. |
| AC-A2-3 | `#random`'s first message must be reachable in the opening window. |
| AC-B8-4 | Clipboard paste — the criterion itself marks Playwright optional; verify by hand. |
| demo steps 2, 3, 5, 6 | Step 2 asserts the seeded `3` badge on `#random`; steps 3/5/6 act on seeded rows that must be in the opening window. |

## Fixture-side defects found and fixed in this suite (no dev action)

Recorded so the same trap is not re-introduced.

1. **`findMessage` only read one `/messages` page.** Once `#general` grew past 200 events the
   `beforeAll` lookup of message #2/#3/#34 failed and aborted the whole conversation suite.
   Fixed with `ApiUser.messagesDeep()`, which follows `end` tokens across pages.
2. **Reading a row id straight after `toBeVisible()`** captured the local-echo id (`message-~…`),
   which then detached when the remote echo re-keyed the row. AC-B9-3 failed spuriously ("edits my
   last message" landed on the previous message). Fixed with `settledEventId()` in `fixtures/ui.ts`.
3. **Backwards read receipts do not work.** Synapse silently keeps the newer receipt, so a consumed
   unread precondition cannot be restored by re-sending the older `m.read`. Verified directly
   against this homeserver; this is why `fixtures/state.ts` tops rooms up from a second user and
   derives expected unread counts instead of hard-coding the seeded numbers.
4. **`unread_notifications` on an *initial* `/sync` is stale on this Synapse build** (it kept
   reporting 3 after a receipt had zeroed the room; incremental syncs were correct). All unread
   assertions therefore go through `ApiUser.unreadFor()`, which derives the count from receipts plus
   the timeline, and never read unread from `/sync`.
