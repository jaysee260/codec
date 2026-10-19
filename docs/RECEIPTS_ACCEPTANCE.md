# Read receipts: Acceptance Criteria and Test ID Contract

Extends docs/ACCEPTANCE.md and the Phase 2-6 acceptance docs (conventions, registries and criteria stay in force). Numbering `AC-R<group>-<n>`; each group names its tickets (docs/RECEIPTS_TICKETS.md). **P0** = the demo script in docs/RECEIPTS_DEMO.md breaks without it, P1 = noticeably better, P2 = polish. "desktop" = the `desktop` Playwright project, "phone" = `mobile`, logged in as **alice** unless stated; **dirty seed always allowed**: every criterion sends its own message (in `#dev`, or `#vault` for encrypted) and asserts on its own event id. API names follow docs/RECEIPTS_TICKETS.md "Shared API"; the Principal's docs/ARCHITECTURE.md "Read receipts deltas" wins on names, never on behaviour.

## Seed data and users (docs/SEED_DATA.md, shipped `seed/seed.ts`)
| Thing | Value | Used for |
|---|---|---|
| alice (`@alice:localhost`, "Alice Park") | demo driver, the browser user | the viewer in every criterion |
| bob (`@bob:localhost`, "Bob Ruiz") | second live user | second browser context (`secondContext(browser, 'bob')` from `e2e/fixtures/e2ee.ts`) or API (`asUser('bob')`) |
| carol, dave (`@carol:localhost` "Carol Nguyen", `@dave:localhost` "Dave Okafor") | API-only readers (`ApiUser.receipt(roomId, eventId, threadId?)` in `e2e/fixtures/matrix-api.ts`) | second and third avatar; "Not seen yet" entries |
| `#dev` (`roomId('dev')`) | plain room, members alice, bob, carol, dave (carol joined in Phase 3; SEED_DATA's "not in #dev" is stale, the shipped seed wins) | every plain-room criterion |
| `#vault` (`roomId('vault')`) | encrypted room, members alice, bob, dave | encrypted criteria (AC-R1-2, AC-R2-6) |
| `#general` | the demo's quiet room | never used by specs (fresh-seed signal) |
| "other readers" | from alice's view at most **3** per seeded room (bob, carol, dave) | "+N" needs throwaway users: `freshUser(prefix)`, `createRoom`, `joinRoom` in `e2e/fixtures/e2ee-api.ts` (open registration on the test Synapse); see AC-R2-4 |

"A reads E" in a spec = `await (await asUser('X')).receipt(roomId, E)` (main timeline) or `.receipt(roomId, E, rootId)` (thread). "bob reads E in the browser" = bob's context opens the room with E as the newest event and waits for his client to send its receipt (the app marks the room read when pinned to the bottom).

## Test ID registry (additions)
### Receipts feature (Dev A, `src/features/receipts/**`)
| testid | Element |
|---|---|
| `receipt-status` (+`data-status="sending\|sent\|failed"`) | Own rows only. One per row, at the row's trailing edge. `sending`: hollow circle, `aria-label="Sending…"`, `title="Sending…"`. `sent`: check, `aria-label="Sent"`, `title="Sent"`. `failed`: the existing failed UI keeps its testids; `receipt-status[data-status="failed"]` wraps or sits next to it. Absent on other people's rows, and absent on own rows that are not the newest own unread message (see AC-R1-3). |
| `receipt-avatars` (+`data-count` = number of readers, `data-event-id`) | Strip under a row, present only when at least one other user's latest read point is this row. `role="button"`, `aria-haspopup="dialog"`, `aria-expanded` (true while its list is open), `aria-label="Seen by Bob Ruiz, Carol Nguyen"` (display names, newest reader first, max 3 names then "and N others"). Hover (desktop) and click / tap open `receipt-list`. |
| `receipt-avatar` (+`data-user-id`) | One per reader shown, max 3, `<img>` or initial fallback with `alt=""` (the group carries the label) |
| `receipt-more` | "+N" chip when `data-count > 3`, text `+N` |
| `receipt-list` (+`data-event-id`, `data-mode="popover\|sheet"`) | The Seen by list. `role="dialog"`, `aria-label="Seen by"`, `aria-modal="true"` on phone. Exactly one in the document at a time. Escape and outside click (`receipt-list-backdrop` on phone) close it. |
| `receipt-list-seen` | Section "Seen by" (heading text "Seen by"); hidden when nobody has seen it, replaced by `receipt-list-empty` "Nobody has seen this yet" |
| `receipt-list-unseen` | Section "Not seen yet" (heading text "Not seen yet"); when `truncated` (> 50 members) shows only `receipt-list-unseen-count` "N others haven't seen it yet" |
| `receipt-list-item` (+`data-user-id`, `data-section="seen\|unseen"`) | Name + avatar (+ time read, `receipt-list-time`, in the seen section; `title` = full date-time) |
| `receipt-list-backdrop` | Phone sheet backdrop |
| `settings-send-read-receipts` | The toggle, `role="switch"` (or `<input type="checkbox">`), `aria-checked="true\|false"`, label text "Send read receipts"; 44 px tall on phone |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `message-action-seen-by` | "Seen by" button in `message-actions` (desktop toolbar) and a row in `message-action-sheet` (phone). Opens `receipt-list` for that row. Present on every message row (own and others'), absent on redacted rows. |
| `message-{eventId}` (existing) | Hosts `receipt-status` and `receipt-avatars`; both inside the row element so `getByTestId('message-' + id).getByTestId('receipt-avatars')` works, main timeline and `thread-panel` alike |

### Core (Principal)
| name | Shape |
|---|---|
| `window.__matrixPoc.receipts` | `{ getReadPoints(roomId, threadRootId?) -> Record<eventId, Reader[]>, getSeenBy(roomId, eventId, threadRootId?) -> { seen, notSeen, truncated }, getSendReadReceipts() -> boolean, setSendReadReceipts(on) -> Promise<void> }` (`src/app/devtools.ts`) |
| account data `im.vector.web.settings` | `{ ..., sendReadReceipts: boolean }`; other keys untouched by `setSendReadReceipts` |

## Criteria

### AC-R1 Send status on own messages (PRIN-R1, DEV-A-R1, DEV-B-R1)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R1-1 | P0 | Given `#dev`, when alice sends "status check <nonce>", then her row (`message-{id}`) shows `receipt-status[data-status="sending"]` with `aria-label="Sending…"` while the echo is pending (QA: `page.route` delays `**/send/**` by 1 s to observe it) and `receipt-status[data-status="sent"]` with `aria-label="Sent"` within 5 s of the response; no `receipt-avatars` on that row. Other users' rows (bob via API) never carry `receipt-status`. |
| AC-R1-2 | P0 | Given `#vault` (encrypted; alice set up / verified per the e2ee fixtures), when alice sends "vault status <nonce>", then the same `sending` -> `sent` flip happens on the row whose final testid is `message-{realEventId}` (not a `~txn` id), within 5 s; `data-status` is never stuck at `sending` after the event has a `$` id. |
| AC-R1-3 | P0 | Given alice sends M1 then M2 in `#dev` with nobody reading either, then only **M2** (her newest) carries `receipt-status[data-status="sent"]`; M1 carries neither `receipt-status` nor `receipt-avatars`. When alice sends M3, the check moves to M3 and M2 loses it. |
| AC-R1-4 | P0 | Given M2 is alice's newest message with the sent check, when bob reads M2 (API), then within 5 s M2's `receipt-status` is **gone** and `receipt-avatars[data-count="1"]` with `receipt-avatar[data-user-id="@bob:localhost"]` is under M2 (the check is replaced by the readers, Element behaviour). When alice then sends M4, M4 gets the check and M2 keeps bob's avatar. |
| AC-R1-5 | P0 | Given a send that fails (QA: route `**/send/**` to 500 / abort), then the row shows `receipt-status[data-status="failed"]` alongside the existing failed UI, and the retry path from Phase 1 still works; a failed message never holds the "sent" check. |

### AC-R2 Read avatars (PRIN-R1, DEV-A-R2, DEV-B-R1)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R2-1 | P0 | Given alice sends A1 in `#dev` and bob's browser context (`secondContext(browser, 'bob')`) opens `#dev` pinned to the bottom, then **without any reload** alice's row A1 shows `receipt-avatars[data-count="1"]` with bob's `receipt-avatar` within 5 s of bob's client sending its receipt; `aria-label` is "Seen by Bob Ruiz". |
| AC-R2-2 | P0 | Given bob's avatar is under A1, when alice sends A2 and bob reads A2 (API or browser), then bob's avatar **moves**: A1 has no `receipt-avatars`, A2 has `data-count="1"` with bob. When carol then reads A1 (API), A1 shows carol only and A2 still shows bob. |
| AC-R2-3 | P0 | Given alice sends A3 in `#dev` and bob (API) posts a **reaction** to A3 and then reads the reaction event (receipt on the reaction's event id), then bob's avatar is under A3 (the nearest earlier rendered row); the same holds for a receipt on an **edit** event of A3 and on a **redaction** event (the redacted row stays rendered as `message-redacted`, so it keeps the avatar). |
| AC-R2-4 | P1 | Given 5 readers at one row, then at most 3 `receipt-avatar` render plus `receipt-more` with text `+2`, `data-count="5"`, and the `aria-label` reads "Seen by X, Y, Z and 2 others" (unit / component test: `buildReadPoints` + `ReadAvatars` with 5 fake readers, `npm run test:unit`). **e2e** (Advisor consult 1): QA registers 4 throwaway users with `freshUser('qarcpt')` (`e2e/fixtures/e2ee-api.ts`; open registration on the test Synapse), creates a fresh room as alice (`createRoom`) and invites + `joinRoom`s them, posts one message as alice, sends `m.read` receipts for all 4 via API, and asserts on alice's page `receipt-avatars[data-count="4"]`, exactly 3 `receipt-avatar`, `receipt-more` text `+1`. Pure API, no extra browser contexts, no seed change. |
| AC-R2-5 | P0 | Given bob, carol and dave have all read A4 (API), then `receipt-avatars[data-count="3"]` under A4 shows three `receipt-avatar`s, newest reader first, and no `receipt-more`; alice's own receipt never produces an avatar on any row. |
| AC-R2-6 | P0 | Given `#vault`, when alice sends V1 and bob reads it (API receipt works without decrypting), then V1 shows bob's avatar exactly as in `#dev`; a row that bob's client cannot decrypt (QA: alice's second, unverified context sees `message-undecryptable` for an older message) still shows `receipt-avatars` when someone's read point is there. |
| AC-R2-7 | P1 | Given a receipt from a user who later **leaves** the room, then their avatar disappears on the next receipt rebuild (joined members only); users with no avatar render the initial fallback, not a broken image. |

### AC-R3 Seen-by list (PRIN-R1, DEV-A-R3, DEV-B-R2)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R3-1 | P0 | Given A5 in `#dev` read by bob and carol (API, bob after carol), when alice **hovers** `receipt-avatars` on desktop, then `receipt-list[data-event-id=A5][data-mode="popover"]` opens with `receipt-list-seen` listing `receipt-list-item[data-user-id=@bob][data-section="seen"]` **before** carol (newest first), each with the display name and a `receipt-list-time`, and `receipt-list-unseen` listing exactly `@dave:localhost` with `data-section="unseen"`. Alice (the viewer) and the sender appear in neither section. |
| AC-R3-2 | P0 | When alice **clicks** `receipt-avatars` instead, then the same list opens and stays open after the pointer leaves; **Escape** closes it, and so does a click outside; at most one `receipt-list` exists at any time (opening a second row's list closes the first). |
| AC-R3-3 | P0 | Given alice sends A6 that **nobody** has read, then the row has no `receipt-avatars`; when alice hovers the row and clicks `message-action-seen-by` in `message-actions`, then `receipt-list` opens with `receipt-list-empty` "Nobody has seen this yet" (no `receipt-list-seen`) and `receipt-list-unseen` listing bob, carol and dave (everyone joined except alice). Given bob's message B1 (API) unread by alice's peers, the unseen list for B1 excludes bob (the sender) and alice (me): carol and dave. |
| AC-R3-4 | P0 | Given alice's own receipts are private (AC-R7) or she has read A5, then she still never appears in `receipt-list-seen` or `receipt-list-unseen` of any row; a user with private receipts (QA: bob posts `m.read.private` via API) appears under **Not seen yet**, never under Seen by. |
| AC-R3-5 | P1 | Given `getSeenBy` for a room with > 50 joined members (unit test with fake members; no such seeded room), then `truncated` is true, `notSeen` is empty and the UI shows `receipt-list-unseen-count` "N others haven't seen it yet" instead of items. |
| AC-R3-6 | P1 | Given the list is open, then focus is inside it (first item or the dialog), Tab cycles within, and closing returns focus to the trigger (`receipt-avatars` or `message-action-seen-by`). |

### AC-R4 "Seen by" from message actions (DEV-B-R2, DEV-A-R3)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R4-1 | P0 | Given any non-redacted row in `#dev` (own or bob's), when alice hovers it, then `message-actions` contains `message-action-seen-by` with `aria-label="Seen by"`; clicking it opens `receipt-list[data-event-id=<that row>]`; the existing actions (`message-action-react`, `-reply`, `-thread`, `-edit`, `-delete`) keep their testids and order. With the thread panel open (narrowest message column, `--thread-w`) every action button is still visible and clickable (the toolbar may wrap; no overflow menu). |
| AC-R4-2 | P0 | Given a redacted row (`message-redacted`), then `message-action-seen-by` is absent. |

### AC-R5 Phone (DEV-A-R2, DEV-A-R3, DEV-B-R2)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R5-1 | P0 | **phone** (Pixel 7): given A7 read by bob (API), when alice **taps** `receipt-avatars`, then `receipt-list[data-mode="sheet"]` opens as a bottom sheet with `receipt-list-backdrop`, `role="dialog"`, `aria-modal="true"`; tapping the backdrop closes it; `document.documentElement.scrollWidth <= innerWidth`. |
| AC-R5-2 | P0 | **phone**: given alice long-presses (the existing `message-action-sheet` gesture) a row nobody read, then the sheet has `message-action-seen-by`; tapping it closes the action sheet and opens the Seen by sheet showing `receipt-list-unseen` with bob, carol and dave. |
| AC-R5-3 | P0 | **phone**: `receipt-avatars` (as a tap target) and every `receipt-list-item` are at least 44 px tall; `settings-send-read-receipts` is at least 44 px tall and reachable from the UserFooter area on phone. |

### AC-R6 Threads (PRIN-R1, DEV-B-R1)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R6-1 | P0 | Given a thread in `#dev` with root R (bob, API) and alice's reply T1, when bob reads T1 with a **threaded** receipt (`receipt(roomId, T1, R)`), then inside `thread-panel` the row `message-{T1}` shows bob's `receipt-avatars`, and the main-timeline rows show **no** avatar for that threaded receipt (main rows use main receipts only). |
| AC-R6-2 | P0 | Given bob reads a main-timeline message M with a receipt carrying `thread_id: "main"` (API), then no row inside `thread-panel` moves or gains bob's avatar for that receipt: a receipt with `thread_id` 'main' never moves a thread avatar. |
| AC-R6-2b | P0 | Given bob posts an **unthreaded** receipt (no `thread_id`) on main message M sent **after** thread reply T1, then per the Matrix spec it counts for threads too: inside `thread-panel` bob's avatar sits on the newest reply older than M (T1), consistent with `getSeenBy` / `hasUserReadEvent` (SDK v43 `Thread.getEventReadUpTo` falls back to the newer unthreaded receipt, compared by `ts`; Element behaves the same). Not a bug (Advisor consult 3). |
| AC-R6-3 | P0 | Given alice's reply T2 is her newest message in the thread and nobody read it, then `message-{T2}` inside `thread-panel` carries `receipt-status[data-status="sent"]`; her newest **main**-timeline message carries its own sent check independently (one per timeline). |
| AC-R6-4 | P1 | Given a threaded receipt on a reaction to T1 (hidden in the thread), then bob's avatar attaches to T1 (nearest earlier rendered thread row). |

### AC-R7 Private receipts setting (PRIN-R2, DEV-A-R4)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R7-1 | P0 | Given a fresh alice (account data has no `sendReadReceipts`), then `settings-send-read-receipts` in the UserFooter area has `aria-checked="true"` (default ON) and `__matrixPoc.receipts.getSendReadReceipts()` is `true`. |
| AC-R7-2 | P0 | When alice toggles it **OFF** and then reads bob's new message B2 in `#dev` (scroll to bottom / room marked read), then the receipt request is `POST .../receipt/m.read.private/{B2}` (never `m.read`; QA listens on `**/receipt/**`), bob's context never shows alice's avatar under B2 (wait 5 s, assert absent), and alice's own unread badge for `#dev` still clears (`unreadByRoom` 0 / no badge). |
| AC-R7-3 | P0 | Given OFF, then alice **still sees** bob's public receipts (bob reads A8 -> bob's avatar under A8); when she toggles **ON** again and reads B3, the request is `m.read` and bob's context shows her avatar under B3. |
| AC-R7-4 | P0 | Given OFF, then account data `im.vector.web.settings` (API: `GET /user/{alice}/account_data/im.vector.web.settings`) contains `sendReadReceipts: false` **and** any pre-existing keys (QA seeds `{"someOtherKey": 1}` via API before toggling) are still present (merge, never clobber). After a page **reload** the toggle is still OFF and `getSendReadReceipts()` is `false`; a `PUT` to the account data from the API (as Element would do) flips the toggle live without a reload. |
| AC-R7-5 | P1 | The toggle is keyboard operable (Space / Enter), labelled "Send read receipts" with a one-line hint ("When off, others can't see what you've read"), and renders inside the UserFooter area on desktop and inside the drawer / footer on phone. |

### AC-R8 Accessibility (DEV-A-R2, DEV-A-R3)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R8-1 | P0 | `receipt-status` has `aria-label` "Sending…" / "Sent" and a matching `title`; `receipt-avatars` has `role="button"`, `aria-haspopup="dialog"`, `aria-expanded` and `aria-label` "Seen by <names>"; individual `receipt-avatar` images have `alt=""`; `receipt-list` has `role="dialog"` and `aria-label="Seen by"`. |
| AC-R8-2 | P0 | Given `receipt-list` is open (popover or sheet), when **Escape** is pressed, then it closes and focus returns to the trigger; `receipt-avatars` is focusable (`tabindex="0"`) and Enter / Space opens the list. |
| AC-R8-3 | P1 | Avatars and the status icon respect `prefers-reduced-motion` (no slide animation when set); contrast of `receipt-more` text meets 4.5:1 in both themes. |

### AC-R9 Scroll stability (DEV-B-R3)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R9-1 | P0 | Given alice is pinned to the bottom of `#dev` (AC-B1-1), when bob (API) reads her newest message and `receipt-avatars` appears under it (replacing the check), then the list is still at the bottom (`scrollHeight - scrollTop - clientHeight < 2`) and no row above moved by more than 2 px (**regression for stick-to-bottom**, BUG-28 family). |
| AC-R9-2 | P0 | Given alice scrolled up 20 messages and reading an older row, when avatars move between rows **below** the viewport (bob reads newer messages), then the row she is reading keeps its on-screen position within 2 px. |
| AC-R9-3 | P1 | Avatars moving between two rows that are both in view do not change the row heights by more than the avatar strip's fixed height; no layout shift elsewhere in the row. |

### AC-R10 Core, docs, suites (PRIN-R1..R3, QA-R1..R3)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R10-1 | P0 | `npm run test:unit` covers `receipts.ts`: `getSendStatus` for `SENDING` / `QUEUED` / `ENCRYPTING` / `NOT_SENT` / sent / other-user events; `buildReadPoints` attaching hidden-event receipts to the previous displayed row, excluding me, newest-first ordering, and the 5-reader case (AC-R2-4); `getSeenBy` sender / viewer exclusion and the > 50 truncation (AC-R3-5); `setSendReadReceipts` merge with a foreign key (AC-R7-4). |
| AC-R10-2 | P0 | `__matrixPoc.receipts.getReadPoints(roomId)` and `getSeenBy(roomId, eventId)` return the same data the UI shows for the rows in AC-R2-5 and AC-R3-1 (QA cross-checks one row each). |
| AC-R10-3 | P0 | docs/ARCHITECTURE.md has a "Read receipts deltas" section: the module map, the per-timeline read-points map and the bridge receipt version counter, the hidden-event attachment rule, the threaded vs main receipt rule, the account-data merge, and the `~txn` -> `$id` status gotcha; `npm run typecheck` and `npm run build` pass. |
| AC-R10-4 | P0 | `e2e/receipts.spec.ts` (desktop: AC-R1, R2-1..6, R3-1..4, R4, R6, R7-1..4, R8-1/2, R9-1/2, R10-2) and `e2e/mobile-receipts.spec.ts` (phone: AC-R5, R7-1, R8-2) exist, use `e2e/fixtures/receipts.ts` (`readAs(user, roomId, eventId, threadId?)`, `receiptRequests(page)` listener on `**/receipt/**`, `setSendReadReceiptsViaApi(user, on)`, `accountDataOf(user, type)`), are listed in a `receipts` area of `scripts/select-e2e.mjs` (`scripts/select-e2e.test.mjs` passes), and `npm run test:e2e:receipts` runs both. |
| AC-R10-5 | P0 | Both projects green at the end of Wave C (fresh-seed skips only), recorded in docs/STATUS.md "Read receipts"; Phase 1-6 suites unchanged (rows without receipts render as before; `message-actions` order unchanged apart from the appended Seen by). |
| AC-R10-6 | P0 | Every bug or review finding fixed in Wave C has a regression test in the same change (JC's rule); docs/BUGS.md "Read receipts" lists the spec commands and the severity rule (S1: a public `m.read` sent while the setting is OFF, or a viewer shown as having read something they did not; S2: avatars on the wrong row, status stuck at `sending`, list jumps; S3: cosmetic). |

## P0 / P1 summary
P0: AC-R1-1..5, R2-1..3/5/6, R3-1..4, R4-1/2, R5-1..3, R6-1..3, R7-1..4, R8-1/2, R9-1/2, R10-1..6. P1 (cut first, in this order): R3-6, R8-3, R2-7, R6-4, R9-3, R7-5, R3-5, R2-4 (the unit test for R2-4 is cheap and should stay even if the e2e half is cut).
