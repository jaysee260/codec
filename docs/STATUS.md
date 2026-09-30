# Status Board

Legend: `todo` / `in-progress` / `done` / `blocked`. Update your row when you start, finish, or get stuck; put the blocker or commit in Notes. PM refreshes this at each phase boundary.

Last updated: 2026-09-30, end of Wave 3 triage. Commits: `f5e796c` Wave 1, `b19cb62` .gitattributes, `86fae64` Wave 2 snapshot. Wave 3 fixes (QA fixtures, BUG-1 anchoring rewrite, dev-probe cleanup) are in the working tree, **not yet committed**.

## Wave 1 - Principal
| Item | Status | Owner | Notes |
|---|---|---|---|
| Repo scaffold (Vite + React 18 + TS) | done | Principal | `f5e796c` |
| Homeserver: docker-compose + `homeserver.yaml` (rc_* raised, open registration) | done | Principal | Docker cannot run on this machine (CPU virtualization off in BIOS); `scripts/hs.mjs` auto-falls back to Synapse in WSL1 distro `matrix-hs` via `homeserver/wsl/hs.sh`. Same config, same URL. |
| Seed script + `seed/seed-output.json` | done | Principal | `npm run seed` / `npm run seed:reset` per docs/SEED_DATA.md |
| Client + stores (`src/lib`, `src/store`) | done | Principal | Shared API per docs/TICKETS.md |
| App shell + login + `theme.css` | done | Principal | Shell testids in place (`e2e/shell.spec.ts` 5/5) |
| docs/ARCHITECTURE.md | done | Principal | |

## Wave 2 - Dev A (navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-1 Space rail + switching | P0 | done | Dev A | `86fae64`; AC-A1 green |
| DEV-A-2 Channel list + header + switching | P0 | done | Dev A | AC-A2-3 skips on a dirty seed (guarded), passes on fresh |
| DEV-A-3 DM list | P0 | done | Dev A | |
| DEV-A-4 Member list panel | P0 | done | Dev A | |
| DEV-A-5 Unread badges | P0 | done | Dev A | Badge was correct in the demo-step-2 failure; the fixture was wrong (NB-10) |
| DEV-A-6 Create channel dialog | P1 | done | Dev A | 2.3 s on an idle homeserver; NB-15 was two suites racing |
| DEV-A-7 Invite user dialog | P1 | done | Dev A | |
| DEV-A-8 Create space dialog | P1 | done | Dev A | |
| DEV-A-9 New DM dialog | P2 | done | Dev A | |
| DEV-A-10 Navigation polish pass | P2 | todo | Dev A | Not scheduled before the demo |

## Wave 2 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-1 Timeline rendering + grouping | P0 | done | Dev B | AC-B1-1 skips on a dirty seed (guarded) |
| DEV-B-2 Composer send + typing send | P0 | done | Dev B | |
| DEV-B-3 Backwards pagination + scroll anchoring | P0 | in-progress | Dev B | **BUG-1** (AC-B3-2, S2): viewport jumps ~530 px on prepend. Row-pinned anchor rewrite in `MessageList.tsx` (working tree), not yet re-verified |
| DEV-B-4 Formatted bodies + image attachments | P0 | done | Dev B | XSS test (AC-B4-4) green |
| DEV-B-5 Reactions + picker | P0 | done | Dev B | |
| DEV-B-6 Replies | P0 | done | Dev B | |
| DEV-B-7 Typing indicator + read receipts | P0 | done | Dev B | Receipts were never broken; red runs came from a fixture cache bug (NB-8/9). `useReadReceipt.ts` rewrite in working tree is a robustness change |
| DEV-B-8 Upload from composer | P0 | done | Dev B | |
| DEV-B-9 Edit + delete actions | P1 | done | Dev B | Tests AC-B9-2/B9-4 still need the `settledEventId` fix (NB-12/13, Dev B owns those tests) |
| DEV-B-10 @mention autocomplete | P2 | done | Dev B | |
| DEV-B-11 Conversation polish pass | P2 | todo | Dev B | Not scheduled before the demo |

## Wave 2 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-1 Playwright scaffold + fixtures | P0 | done | QA | `playwright.config.ts`, `e2e/fixtures/{auth,seed,ui,state}.ts`, `e2e/shell.spec.ts` |
| QA-2 Matrix API helper (second user) | P0 | done | QA | `e2e/fixtures/matrix-api.ts`; sync cache-buster + newest-receipt fix this wave |
| QA-3 Smoke test = demo script | P0 | done | QA | `e2e/smoke.spec.ts`, screenshots to `e2e/results/demo/`; step 7 assertion is weak (see dry run) |
| QA-4 Navigation suite | P1 | done | QA | 29 pass / 1 skip on dirty seed |
| QA-5 Conversation suite | P1 | done | QA | |
| QA-6 Bug report format + BUGS.md | P1 | done | QA | `docs/BUGS.md`: 1 bug, 15 non-bugs triaged |
| QA-7 Reset-and-run script + flake pass | P2 | done | QA | `npm run test:e2e:fresh`; `requireFreshSeed` guard in `e2e/fixtures/fresh.ts`; `e2e/README.md` |

## Wave 3 dry run
| Item | Result |
|---|---|
| Reference run (dirty DB, `--workers=1 --reporter=list`) | **73 pass / 14 fail** / 1 skip / 8 did not run. `#general` had grown 40 -> 131 events; seeded unread already consumed. |
| Triage (docs/BUGS.md) | **1 product bug** (BUG-1). 13 non-bugs: 9 stale-seed / test defects (guarded with `requireFreshSeed` or made freshness-independent via `withFullHistory`), 3 fixture defects (Synapse initial-sync cache, threaded vs unthreaded receipts; fixed), 1 environment (two suites racing one homeserver). |
| Re-run after fixes (same dirty DB) | shell **5/5**; navigation **29 pass, 1 skip**; smoke **6 pass, 4 skip** (steps 2/3/5/6 need a fresh seed); conversation tests touched **7 pass, 2 skip**. Nothing red outside BUG-1 and Dev B's two test fixes. |
| Fresh-seed run | **Not yet done.** The database could not be reset this session. Run `npm run test:e2e:fresh` before the demo. |

**Open bug**
| ID | AC | Sev | Owner | State |
|---|---|---|---|---|
| BUG-1 | AC-B3-2 pagination scroll anchoring | S2 (demo works, history scroll jumps) | Dev B | Fix in working tree; re-verify with `npx playwright test e2e/conversation.spec.ts -g "AC-B3-2" --workers=1 --reporter=list` |

**Before the stakeholder demo (in order)**
1. Dev B: land BUG-1, apply `settledEventId` to AC-B9-2/B9-4 tests, commit.
2. Principal: add `e2e/results/` to `.gitignore`; delete the stray `e2e/tmp/diag.spec.ts` (staged for deletion but still on disk, so `playwright test` lists 97 tests instead of 96); commit the Wave 3 working tree.
3. QA: `npm run test:e2e:fresh` on a quiet machine; expect all green, 1 intentional skip (AC-B8-4 manual). Tighten smoke step 7 to count `message-image` before/after upload.
4. PM: dry run of docs/DEMO.md end to end with bob in a second window; review `e2e/results/demo/*.png`.

## Requests to Principal
| # | From | Request | Status |
|---|---|---|---|
| 1 | PM | Shared API per docs/TICKETS.md | done |
| 2 | PM | Shell testids per docs/ACCEPTANCE.md | done |
| 3 | PM | `src/app/theme.css` tokens | done |
| 4 | PM | homeserver `rc_*` overrides + `seed/seed-output.json` | done |
| 5 | QA | Add `e2e/results/` to `.gitignore` (`.last-run.json` currently tracked) | open |
