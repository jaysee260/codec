# Status Board

Legend: `todo` / `in-progress` / `done` / `blocked`. Update your row when you start, finish, or get stuck; put the blocker or commit in Notes. PM refreshes this at each phase boundary.

Last updated: 2026-09-30 (Wave 1 in flight, Wave 2 not started)

## Wave 1 - Principal
| Item | Status | Owner | Notes |
|---|---|---|---|
| Repo scaffold (Vite + React 18 + TS) | in-progress | Principal | |
| docker-compose + homeserver.yaml (rc_* raised, open registration) | in-progress | Principal | |
| Seed script + `seed/seed-output.json` | in-progress | Principal | Contract: docs/SEED_DATA.md |
| Client + stores (`src/lib`, `src/store`) | in-progress | Principal | Contract: docs/TICKETS.md "Shared API" |
| App shell + login + `theme.css` | in-progress | Principal | testids: docs/ACCEPTANCE.md "Shell" |
| docs/ARCHITECTURE.md | in-progress | Principal | |

## Wave 2 - Dev A (navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-1 Space rail + switching | P0 | todo | Dev A | |
| DEV-A-2 Channel list + header + switching | P0 | todo | Dev A | |
| DEV-A-3 DM list | P0 | todo | Dev A | |
| DEV-A-4 Member list panel | P0 | todo | Dev A | |
| DEV-A-5 Unread badges | P0 | todo | Dev A | |
| DEV-A-6 Create channel dialog | P1 | todo | Dev A | |
| DEV-A-7 Invite user dialog | P1 | todo | Dev A | |
| DEV-A-8 Create space dialog | P1 | todo | Dev A | |
| DEV-A-9 New DM dialog | P2 | todo | Dev A | |
| DEV-A-10 Navigation polish pass | P2 | todo | Dev A | |

## Wave 2 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-1 Timeline rendering + grouping | P0 | todo | Dev B | |
| DEV-B-2 Composer send + typing send | P0 | todo | Dev B | |
| DEV-B-3 Backwards pagination + scroll anchoring | P0 | todo | Dev B | |
| DEV-B-4 Formatted bodies + image attachments | P0 | todo | Dev B | |
| DEV-B-5 Reactions + picker | P0 | todo | Dev B | |
| DEV-B-6 Replies | P0 | todo | Dev B | |
| DEV-B-7 Typing indicator + read receipts | P0 | todo | Dev B | |
| DEV-B-8 Upload from composer | P0 | todo | Dev B | |
| DEV-B-9 Edit + delete actions | P1 | todo | Dev B | |
| DEV-B-10 @mention autocomplete | P2 | todo | Dev B | |
| DEV-B-11 Conversation polish pass | P2 | todo | Dev B | |

## Wave 2 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-1 Playwright scaffold + fixtures | P0 | todo | QA | |
| QA-2 Matrix API helper (second user) | P0 | todo | QA | |
| QA-3 Smoke test = demo script | P0 | todo | QA | |
| QA-4 Navigation suite | P1 | todo | QA | |
| QA-5 Conversation suite | P1 | todo | QA | |
| QA-6 Bug report format + BUGS.md | P1 | todo | QA | |
| QA-7 Reset-and-run script + flake pass | P2 | todo | QA | |

## Open requests to Principal
| # | From | Request | Status |
|---|---|---|---|
| 1 | PM | Shared API per docs/TICKETS.md "Shared API" | open |
| 2 | PM | Shell testids per docs/ACCEPTANCE.md "Shell" | open |
| 3 | PM | `src/app/theme.css` tokens per docs/PLAN.md | open |
| 4 | PM | homeserver.yaml `rc_*` overrides + `seed/seed-output.json` | open |
