# Matrix POC — Charter

**Goal.** Ship a browser chat client on Matrix/Synapse that a stakeholder can open, log in to, and use for two minutes without noticing it is not Discord. Optimise for feel, not completeness. If it lands, more features follow.

## What "lands well" means
1. The stakeholder completes the demo script below with no crash, blank screen, or manual refresh.
2. App shell paints within 3 s of login against the seeded homeserver; switching channels feels instant (< 200 ms).
3. Three-column dark Discord layout: grouped messages, hover actions, reaction pills, typing indicator, unread badges. A daily Discord user says "yes, that's the shape".
4. A second live user (bob) typing and posting appears in real time, no refresh.
5. `npm run test:e2e` is green on a fresh `npm run seed:reset`.

## In scope (Wave 2)
| Area | Owner | Features |
|---|---|---|
| Auth + shell | Principal | Login form, session persisted in localStorage, logout, three-column shell, loading state |
| Navigation | Dev A | Space rail, channel list per space, DM list, member list, unread badges, create channel, create space, invite user, start DM |
| Conversation | Dev B | Timeline + backwards pagination, sender grouping, day dividers, HTML bodies via DOMPurify, images, edited/deleted rendering, reactions + picker, replies, typing indicator, read receipts, composer (Enter / Shift+Enter), upload, @mention autocomplete |
| QA | QA | Playwright suite, smoke test = demo script, bug report format |
| Infra | Principal | Synapse in Docker (SQLite, open registration), seed script, matrix client + Zustand stores, `docs/ARCHITECTURE.md` |

## Out of scope (explicitly)
Voice/video · end-to-end encryption (all rooms created unencrypted) · push notifications · mobile / responsive layouts · federation · threads · SSO/OIDC · message search · pins · permission/role UI beyond seeded power levels · custom emoji · notification settings · profile/avatar editing · room settings · presence dots (P2 stretch only) · i18n · accessibility audit (basic keyboard use only).

## Demo script (~2 minutes, driven by the stakeholder)
Prep by us: `npm run hs:up && npm run seed && npm run dev`; a second browser window (incognito) logged in as **bob** with the alice DM open; app at http://localhost:5173.

| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Log in as `alice` / `password123` | Shell in < 3 s. Space rail: Home, **Acme HQ**, **Gaming**. Acme HQ selected, `#general` open. |
| 2 | Glance at the channel list | `#general`, `#random` (badge **3**), `#dev`. Gaming rail icon has an unread dot. Member list shows alice, bob, carol, dave. |
| 3 | Scroll `#general` | ~40 messages grouped by sender with avatar + name + time on the first of each run. Bold text, a code block, a clickable link, an image, a reply quote, a 👍 ×2 pill, a "(edited)" marker. Scrolling to the top loads older messages, then shows "This is the beginning of #general". |
| 4 | Type `Hello from the demo` and press Enter | Message appears instantly at the bottom under alice. Shift+Enter makes a newline without sending. |
| 5 | Hover bob's "Lunch today?" message, click the react icon, pick 🎉 | 🎉 pill appears with count 1, highlighted as "mine". Click again to remove it. |
| 6 | Hover carol's "Will there be snacks?", click Reply, type `Yes`, Enter | Composer shows "Replying to carol"; sent message renders a quote block of carol's text above it. |
| 7 | Click the attach button, choose any PNG/JPG | Image bubble appears in the timeline, thumbnail sized ≤ 400 px, click opens full size. |
| 8 | Click `#random` | Badge clears. Reading the room marks it read (survives reload). |
| 9 | Click **bob** in the DM list; in the bob window, start typing then send "On my way" | "bob is typing…" indicator, then bob's message arrives live under a new sender group. |
| 10 | Click **Gaming**, press **+** next to "Text Channels", create `memes` | `#memes` appears in the list and opens. Click the space name, choose Invite, enter `@carol:localhost`, submit. Member list shows carol as invited. |

## Look and feel (shared tokens so both devs match)
Principal exposes these in `src/app/theme.css`; devs use only the variables.
`--bg-rail #1e1f22` · `--bg-sidebar #2b2d31` · `--bg-chat #313338` · `--bg-hover #35373c` · `--bg-active #404249` · `--bg-input #383a40` · `--bg-tooltip #111214` · `--text-normal #dbdee1` · `--text-muted #949ba4` · `--text-heading #f2f3f5` · `--text-link #00a8fc` · `--accent #5865f2` · `--danger #f23f43` · `--success #23a559` · `--radius 8px` · font stack `"gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif`, 16 px base, 15 px messages. Rail 72 px, sidebar 240 px, member panel 240 px.

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Initial sync slow / blank screen | Demo step 1 fails | `initialSyncLimit: 30`, `lazyLoadMembers: true`, memory store (no IndexedDB in POC), keep seed under ~80 events, show a loading screen with the Acme logo, never render the shell before `PREPARED`. |
| matrix-js-sdk event ordering (local echo, pagination, timeline reset) | Duplicate / jumping messages | Single source of truth = `room.getLiveTimeline().getEvents()`; stores re-read it on `Room.timeline`, `Room.timelineReset`, `Event.localEventIdReplaced`; never keep a parallel array; key rows by `event.getId()`; pin scroll position across `paginateBack`. |
| Docker Desktop on Windows | Homeserver won't start / data perms | WSL2 backend; named volume for `/data`, not a bind mount; generate config once with `generate`; `npm run hs:up` waits on `/_matrix/client/versions`; port 8008 conflict check documented. |
| Synapse rate limits during seed and tests | 429s, flaky tests | `homeserver.yaml`: `rc_message`, `rc_login`, `rc_registration`, `rc_joins`, `rc_invites` set to `per_second: 1000, burst_count: 1000`; seed and QA helpers retry on 429 honouring `retry_after_ms`. |
| Edits/reactions/redactions aggregation | Seeded history renders wrong | Rely on SDK relation aggregation (`event.replacingEvent()`, `timelineSet.relations`, `event.isRedacted()`); hide `m.replace` / `m.reaction` rows in the list. |
| Two devs collide on files | Merge pain | Strict ownership map in `docs/TICKETS.md`; shared layers change only via Principal. |
| "Doesn't feel like Discord" | Stakeholder unimpressed | Shared tokens above; DEV-A-10 / DEV-B-11 polish tickets; demo dry run in Wave 3 with screenshots compared against Discord. |
| Playwright on Windows | QA blocked | `npx playwright install chromium` in `postinstall`; Chromium only; tests use `data-testid` only, never text-of-CSS. |

## Waves
| Wave | Who | Output |
|---|---|---|
| 1 (now) | Principal | Repo, docker-compose, seed, client/stores, shell, ARCHITECTURE.md |
| 2 | Dev A, Dev B, QA in parallel | Tickets in `docs/TICKETS.md`; P0 first |
| 3 | All | Integration, bug fixes from QA, demo dry run, `docs/STATUS.md` final |
