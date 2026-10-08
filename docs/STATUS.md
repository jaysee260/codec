# Status Board

Legend: `todo` / `in-progress` / `done` / `blocked`. Update your row when you start, finish, or get stuck; put the blocker or commit in Notes. PM refreshes this at each phase boundary.

Last updated: 2026-10-07 (Phase 3 planned, every ticket `todo`; see the Phase 3 block at the end). Phase 2: Wave 2 snapshot `5814c90` (Phase 2 Wave 1 `0913d00`; Phase 1 block below is as of 2026-09-30, end of Wave 3). Commits: `f5e796c` Wave 1, `b19cb62` .gitattributes, `86fae64` Wave 2, `e714746` Wave 3, `68c85a7` AC-B10-2 test fix. The BUG-3 fix (`actions.ts`, `rooms.ts`, homeserver config) and this docs pass are in the working tree, to be committed by the orchestrator.

## Wave 1 - Principal
| Item | Status | Owner | Notes |
|---|---|---|---|
| Repo scaffold (Vite + React 18 + TS) | done | Principal | `f5e796c` |
| Homeserver: docker-compose + `homeserver.yaml` (rc_* raised, open registration) | done | Principal | Docker cannot run on this machine (CPU virtualization off in BIOS); `scripts/hs.mjs` auto-falls back to Synapse in WSL1 distro `matrix-hs` via `homeserver/wsl/hs.sh`. `rc_room_creation` relaxed in Wave 3 (BUG-3); applies on next restart. |
| Seed script + `seed/seed-output.json` | done | Principal | `npm run seed` / `npm run seed:reset` per docs/SEED_DATA.md |
| Client + stores (`src/lib`, `src/store`) | done | Principal | Wave 3: `retryOnRateLimit` in actions, pending-selection invariant in `rooms.ts` |
| App shell + login + `theme.css` | done | Principal | `e2e/shell.spec.ts` 5/5 |
| docs/ARCHITECTURE.md | done | Principal | Updated for the Wave 3 store change |

## Wave 2 - Dev A (navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-1 Space rail + switching | P0 | done | Dev A | `86fae64` |
| DEV-A-2 Channel list + header + switching | P0 | done | Dev A | AC-A2-3 skips on a dirty seed (guarded) |
| DEV-A-3 DM list | P0 | done | Dev A | |
| DEV-A-4 Member list panel | P0 | done | Dev A | |
| DEV-A-5 Unread badges | P0 | done | Dev A | |
| DEV-A-6 Create channel dialog | P1 | done | Dev A | BUG-3 (new room not listed) was store + rate limit, fixed by Principal; AC-A6 green |
| DEV-A-7 Invite user dialog | P1 | done | Dev A | |
| DEV-A-8 Create space dialog | P1 | done | Dev A | Same BUG-3 fix; AC-A8 green |
| DEV-A-9 New DM dialog | P2 | done | Dev A | |
| DEV-A-10 Navigation polish pass | P2 | todo | Dev A | Not scheduled before the demo |

## Wave 2 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-1 Timeline rendering + grouping | P0 | done | Dev B | BUG-1 (flex-shrunk rows overlapping) fixed; AC-B1-1 skips on a dirty seed (guarded) |
| DEV-B-2 Composer send + typing send | P0 | done | Dev B | |
| DEV-B-3 Backwards pagination + scroll anchoring | P0 | done | Dev B | BUG-2 fixed: row-pinned anchor, drift 0.4 px; AC-B3-2 passes |
| DEV-B-4 Formatted bodies + image attachments | P0 | done | Dev B | AC-B4-2 hit a Playwright artifact ENOENT once at context close; passes on rerun |
| DEV-B-5 Reactions + picker | P0 | done | Dev B | |
| DEV-B-6 Replies | P0 | done | Dev B | |
| DEV-B-7 Typing indicator + read receipts | P0 | done | Dev B | Earlier red runs were a fixture cache bug, not the product |
| DEV-B-8 Upload from composer | P0 | done | Dev B | |
| DEV-B-9 Edit + delete actions | P1 | done | Dev B | |
| DEV-B-10 @mention autocomplete | P2 | done | Dev B | AC-B10-2 test defect fixed in `68c85a7` |
| DEV-B-11 Conversation polish pass | P2 | todo | Dev B | Not scheduled before the demo |

## Wave 2 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-1 Playwright scaffold + fixtures | P0 | done | QA | |
| QA-2 Matrix API helper (second user) | P0 | done | QA | Sync cache-buster + newest-receipt fix |
| QA-3 Smoke test = demo script | P0 | done | QA | Screenshots to `e2e/results/demo/` |
| QA-4 Navigation suite | P1 | done | QA | `expectChannelListed` diagnostic added for BUG-3 |
| QA-5 Conversation suite | P1 | done | QA | |
| QA-6 Bug report format + BUGS.md | P1 | done | QA | 3 bugs logged, all fixed |
| QA-7 Reset-and-run script + flake pass | P2 | done | QA | `npm run test:e2e:fresh`; `requireFreshSeed` guard |

## Wave 3 dry run
| Item | Result |
|---|---|
| Reference run (dirty DB) | 73 pass / 14 fail / 1 skip / 8 did not run. Triage: stale seed, fixture defects, and three product bugs (docs/BUGS.md). |
| Bugs | **BUG-1** flex-shrunk rows intercepting clicks (S1, Dev B) fixed. **BUG-2** pagination anchoring jump (S2, Dev B) fixed, drift 0.4 px. **BUG-3** created channel/space not appearing in the sidebar (S1, Principal) fixed: `rc_room_creation` limiter + store selecting before `m.space.parent` arrived. |
| Final clean full-suite run (dirty DB) | **85 pass / 8 skip / 3 fail** (96 tests). Fails: AC-B4-2 (Playwright artifact ENOENT at context close, passes on rerun), AC-B10-2 (test defect, fixed `68c85a7`), AC-A6-2 (BUG-3, now fixed; AC-A6/A8/A1 groups 9/9). Skips: 7 need a fresh seed, 1 manual (clipboard paste). |
| Open bugs | **None.** |
| Fresh-seed run | Not yet done (database could not be reset this session). |

**Before the stakeholder demo**
1. Restart the homeserver once (`npm run hs:down && npm run hs:up`) so the relaxed `rc_room_creation` limit applies.
2. `npm run test:e2e:fresh` on a quiet machine; expect green with 1 intentional skip (AC-B8-4 manual).
3. Dry-run docs/DEMO.md end to end with bob in a second window.

## Requests to Principal
| # | From | Request | Status |
|---|---|---|---|
| 1 | PM | Shared API per docs/TICKETS.md | done |
| 2 | PM | Shell testids per docs/ACCEPTANCE.md | done |
| 3 | PM | `src/app/theme.css` tokens | done |
| 4 | PM | homeserver `rc_*` overrides + `seed/seed-output.json` | done |
| 5 | QA | Add `e2e/results/` to `.gitignore` | done (`e714746`) |
| 6 | QA | Relax `rc_room_creation` (BUG-3) | done (working tree) |

---

# Phase 2 - Phone POC (Capacitor) + voice notes

Plan: docs/PHASE2_PLAN.md · Criteria/testids: docs/PHASE2_ACCEPTANCE.md · Tickets: docs/PHASE2_TICKETS.md. Planned 2026-10-04 by PM; Wave 1 `0913d00`, Wave 2 `5814c90`, dry run below. P0 = phone demo script. Stakeholder handoff: docs/PHASE2_DEMO.md. Waves: 4 Principal core, 5 devs + QA in parallel, 6 device pass + handoff.

## Wave 4 - Principal
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| PRIN-1 Capacitor 7 scaffold + Android debug APK | P0 | done | Principal | `0913d00`. `@capacitor/* ^7.6.9`, `androidScheme: 'http'` + `cleartext` + `allowMixedContent`. APK builds on this machine: `android/app/build/outputs/apk/debug/app-debug.apk`; JDK 21 at `~/jdk21`, SDK at `~/android-sdk` |
| PRIN-2 LAN proxy (8009) + `VITE_HS_URL` + login Homeserver override + `dev:lan` | P0 | done | Principal | `0913d00`. `scripts/lan-proxy.mjs` on 0.0.0.0:8009 -> 127.0.0.1:8008; `getHsUrl()` override on the login screen; homeserver untouched |
| PRIN-3 Layout store + `Drawer` + phone shell | P0 | done | Principal | `0913d00`. Shared API table is the contract for A/B; `npm run verify:phone` 40/40 |
| PRIN-4 Safe area, `100dvh`, viewport meta, keyboard, status bar | P0 | done | Principal | `0913d00`. Keyboard `resize: 'native'` shipped (tickets updated) |
| PRIN-5 Voice core (encoder spike, helpers, `sendVoiceMessage`, `getVoiceMessage`) | P0 | done | Principal | `0913d00`. Spike outcome: the POC ships the native `MediaRecorder` container with no transcoding; `encodeToOggOpus` is an identity seam. See the AC-V2-4 waiver below |
| PRIN-6 iOS project + Info.plist + Mac handoff | P1 | done | Principal | `0913d00`. Done to the extent possible on Windows (`cap copy ios`); build and device run happen on a Mac per docs/PHASE2_PLAN.md |
| PRIN-7 docs/MOBILE.md + ARCHITECTURE deltas | P0 | done | Principal | `0913d00` |

## Wave 5 - Dev A (phone navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-11 Drawer content (rail + channel/DM list) | P0 | done | Dev A | `5814c90`. Marked done on QA evidence (AC-M2 all green in `e2e/mobile-nav.spec.ts`); Dev A's own report still pending |
| DEV-A-12 Phone channel header (`header-menu`, `member-toggle` -> drawer) | P0 | done | Dev A | AC-M3 green |
| DEV-A-13 Member drawer content | P1 | done | Dev A | AC-M4 green |
| DEV-A-14 Touch targets (44 px) | P0 | done | Dev A | AC-M5-1 green |
| DEV-A-15 Dialogs as bottom sheets | P1 | done | Dev A | AC-M5-2..4 green |
| DEV-A-16 Phone navigation polish | P2 | partial | Dev A | `header-menu-unread` shipped; rest not scheduled before the demo |

## Wave 5 - Dev B (voice notes + phone conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-12 Mic button + recording bar (`useVoiceRecorder`) | P0 | done | Dev B | `5814c90`. AC-V1 green |
| DEV-B-13 Send flow: encode -> upload -> event, errors, retry | P0 | done | Dev B | AC-V2/V5 green; native container, `encodeToOggOpus` identity seam (AC-V2-4 waiver) |
| DEV-B-14 Voice message bubble (play/pause, scrubber, duration, waveform) | P0 | done | Dev B | AC-V3/V4 green |
| DEV-B-15 Phone composer + message rows | P0 | done | Dev B | AC-V6-1/2/5/6/7 green |
| DEV-B-16 Long-press message action sheet | P1 | done | Dev B | AC-V6-3/4 green |
| DEV-B-17 Voice polish | P2 | partial | Dev B | Speed control and preview-before-send not done; not scheduled before the demo |

## Wave 5 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-8 `mobile` Playwright project + fixtures | P0 | done | QA | `5814c90`. Projects `desktop` / `mobile` (Pixel 7, fake mic flags, CDP long-press) |
| QA-9 Voice-note suite (API + magic-byte verification) | P0 | done | QA | `e2e/voice.spec.ts`; WAV fixture for bob; native-container magic bytes per the AC-V2-4 waiver |
| QA-10 Mobile navigation suite | P1 | done | QA | `e2e/mobile-nav.spec.ts` |
| QA-11 Mobile smoke = phone demo script + screenshots | P0 | done | QA | `e2e/mobile-smoke.spec.ts`; screenshots in `e2e/demo-mobile/` (01-login-general .. 10-member-drawer) |
| QA-12 Android build check | P0 | done | QA | `npm run test:android-build` 20/20 |
| QA-13 Bug format update (platform column, device template) | P1 | done | QA | docs/BUGS.md "Phase 2" section; BUG-4 logged |

## Phase 2 dry run (2026-10-04, HEAD `5814c90`, dirty homeserver)
| Item | Result |
|---|---|
| `mobile` project (`npm run test:e2e:mobile`) | **58 pass / 0 fail** (52 AC ids), including the phone smoke and the voice suite with API + magic-byte checks |
| `desktop` project (`npm run test:e2e:desktop`, ~14 min) | **88 pass / 0 fail / 8 skip** (fresh-seed skips as in Phase 1: AC-B1-1, AC-B3-1, AC-A2-3, AC-B8-4, demo steps 2/3/5/6) |
| Android build check (`npm run test:android-build`) | **20/20**; APK at `android/app/build/outputs/apk/debug/app-debug.apk` (a rebuild with the LAN URL baked is in progress) |
| Flake pass | 3 full runs clean |
| Fixes landed this wave | Principal: SDK double-encoded upload filename fixed via `uploadMedia` (`actions.ts`); Synapse ignoring `Range` on media downloads documented in docs/ARCHITECTURE.md (the player streams the whole file; fine for voice notes) |
| Open bugs | **BUG-4** (S3, environment): desktop login exceeded the 10 s budget (10.6 s) only at the tail of a 14-minute suite run; passes alone (phone smoke logs in at 1.8 s). Demo-day rule: do not run the suites right before the demo, or `seed:reset` first. No code change proposed. |
| Waived | AC-V2-4, see below |

**Before the stakeholder demo** (carried over from Phase 1, still pending): restart the homeserver once (`npm run hs:down && npm run hs:up`) so the relaxed `rc_room_creation` limit applies; `npm run seed:reset` for the seeded badges; then follow docs/PHASE2_DEMO.md.

## Wave 6 device pass
| Item | Result |
|---|---|
| APK on the stakeholder's Android device, phone demo script 1-10 | not yet run (docs/PHASE2_DEMO.md) |
| Manual criteria (AC-C1-6, AC-M2-8, AC-M6-4/5, AC-V5-3) | not yet run |
| Mac handoff package (iOS) | prepared: `ios/` in the repo, steps in docs/MOBILE.md section 4 |
| AC-V2-4 (Ogg/Opus in Chromium) | **Waived** (PM, 2026-10-04, after the PRIN-5 spike): the POC ships the native `MediaRecorder` container with no transcoding (`audio/webm` on Chromium/Android, `audio/mp4` on iOS), with the real mimetype in the event; `encodeToOggOpus` is an identity seam. Transcoding to Ogg/Opus is **P1** via `opus-recorder` or a WebM -> Ogg remux. AC-V2-2/V2-3 still apply with the native magic bytes. |

## Requests to Principal (Phase 2)
| # | From | Request | Status |
|---|---|---|---|
| 7 | PM | Shared API per docs/PHASE2_TICKETS.md (layout store, Drawer, audio helpers, `sendVoiceMessage`, `getVoiceMessage`, CSS variables) | done (`0913d00`) |
| 8 | PM | Shell testids per docs/PHASE2_ACCEPTANCE.md (`data-layout`, `nav-drawer`, `member-drawer`, `drawer-backdrop`) | done (`0913d00`) |
| 9 | QA | `test:e2e:mobile`, `test:e2e:apk` script lines in `package.json` | done as `test:e2e:mobile`, `test:e2e:desktop`, `test:android-build` (`5814c90`) |

---

# Phase 3 - Threads

Plan: docs/PHASE3_PLAN.md · Criteria/testids: docs/PHASE3_ACCEPTANCE.md · Tickets: docs/PHASE3_TICKETS.md. Planned 2026-10-07 by PM (advisor consults 1-2 recorded in the plan). P0 = the desktop and phone demo scripts. Waves: 7 Principal core (PRIN-8 first, QA gate right after), 8 devs + QA in parallel, 9 dry run + interop check.

## Wave 7 - Principal
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| PRIN-8 `threadSupport: true`, bridge thread events, badge rule (`unreadByRoom` main-only), reply/display hygiene | P0 | todo | Principal | Lands first; QA-17 gate runs on it |
| PRIN-9 Timeline source, `threadRoot` sends, thread pagination, `useThreadSummary`, `useRoomThreads`, `useThreadStore` | P0 | todo | Principal | Names subject to ARCHITECTURE "Phase 3 deltas" |
| PRIN-10 Thread panel container (desktop column swap, phone full-screen, Android back) | P0 | todo | Principal | |
| PRIN-11 `scripts/send-thread-sample.mjs` (`npm run thread:sample`) + ARCHITECTURE deltas | P0 | todo | Principal | Demo steps 4-5 use it |
| PRIN-12 Seed threads in `#dev` | P1 | todo | Principal | Applies on the next `seed:reset`; nobody resets now |

## Wave 8 - Dev A (navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-17 `header-threads` + unread dot + Threads list (popover / sheet) | P0 | todo | Dev A | |
| DEV-A-18 Phone header while a thread is open (`header-back`, `Thread` title) | P0 | todo | Dev A | |
| DEV-A-19 Threads list polish | P2 | todo | Dev A | Not scheduled before the demo |

## Wave 8 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-18 `ThreadSummary` row under thread roots | P0 | todo | Dev B | |
| DEV-B-19 "Reply in thread" action (toolbar + long-press sheet) | P0 | todo | Dev B | |
| DEV-B-20 `ThreadView` (root, divider, list, composer, typing, receipts) | P0 | todo | Dev B | |
| DEV-B-21 Main-timeline and panel hygiene | P0 | todo | Dev B | |
| DEV-B-22 In-thread edits, reactions, delete, voice notes, uploads | P1 | todo | Dev B | |

## Wave 8 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-14 API helpers (`sendThreadReply`, `getThreads`, `getRelations`, threaded receipts) + fixtures + config | P0 | todo | QA | Main-only receipt selection in `readReceiptOf`/`unreadFor` lands before the QA-17 gate |
| QA-15 `e2e/threads.spec.ts` (desktop) | P0 | todo | QA | |
| QA-16 `e2e/mobile-threads.spec.ts` (phone) | P0 | todo | QA | |
| QA-17 Regression gate after PRIN-8 + demo step 11 in both smoke specs | P0 | todo | QA | Needs PRIN-8 and the QA-14 fixture half; gate result goes here before Wave 8 UI is accepted |
| QA-18 docs/BUGS.md Phase 3 section | P1 | todo | QA | |

## Wave 9 dry run
| Item | Result |
|---|---|
| Regression gate after PRIN-8 (`desktop` + `mobile` projects) | not yet run |
| `desktop` project incl. `threads.spec.ts` and smoke step 11 | not yet run |
| `mobile` project incl. `mobile-threads.spec.ts` and phone smoke step 11 | not yet run |
| Element Web interop (thread from alice visible as a thread for bob) | not yet checked (manual) |
| Open bugs | - |

## Requests to Principal (Phase 3)
| # | From | Request | Status |
|---|---|---|---|
| 10 | PM | Shared API per docs/PHASE3_TICKETS.md (`TimelineSource`, `useTimeline`, `threadRoot` sends, `useThreadSummary`, `useRoomThreads`, `useThreadStore`, `threadUnreadByRoom`, thread-aware relations) | todo |
| 11 | PM | Shell `data-thread-open` + `ThreadView` mounting per docs/PHASE3_ACCEPTANCE.md | todo |
| 12 | PM | `thread:sample` script line in `package.json` | todo |
