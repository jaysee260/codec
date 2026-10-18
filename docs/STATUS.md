# Status Board

Legend: `todo` / `in-progress` / `done` / `blocked`. Update your row when you start, finish, or get stuck; put the blocker or commit in Notes. PM refreshes this at each phase boundary.

Last updated: 2026-10-18 (Phase 7 voice calls planned, all tickets todo, see the Phase 7 block at the end; Phase 6 done, see its block). Earlier: 2026-10-17 (Phase 5 E2EE planned, all tickets todo, see the Phase 5 block at the end; Phase 4 done at `89a1b80`, authenticated media + SSO merged in PR #1 `2bd3833`; Phase 3 complete at HEAD, working tree uncommitted; final runs, rulings and the only open bug, BUG-4, in the Phase 3 block at the end). Phase 2: Wave 2 snapshot `5814c90` (Phase 2 Wave 1 `0913d00`; Phase 1 block below is as of 2026-09-30, end of Wave 3). Commits: `f5e796c` Wave 1, `b19cb62` .gitattributes, `86fae64` Wave 2, `e714746` Wave 3, `68c85a7` AC-B10-2 test fix. The BUG-3 fix (`actions.ts`, `rooms.ts`, homeserver config) and this docs pass are in the working tree, to be committed by the orchestrator.

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
| PRIN-5 Voice core (encoder spike, helpers, `sendVoiceMessage`, `getVoiceMessage`) | P0 | done | Principal | `0913d00`. Spike outcome: the POC ships the native `MediaRecorder` container with no transcoding; `encodeToOggOpus` is an identity seam. AC-V2-4 was waived then; met by the "Voice format" change below |
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
| DEV-B-13 Send flow: encode -> upload -> event, errors, retry | P0 | done | Dev B | AC-V2/V5 green; native container at the time (AC-V2-4 waiver, since met: "Voice format" below) |
| DEV-B-14 Voice message bubble (play/pause, scrubber, duration, waveform) | P0 | done | Dev B | AC-V3/V4 green |
| DEV-B-15 Phone composer + message rows | P0 | done | Dev B | AC-V6-1/2/5/6/7 green |
| DEV-B-16 Long-press message action sheet | P1 | done | Dev B | AC-V6-3/4 green |
| DEV-B-17 Voice polish | P2 | partial | Dev B | Speed control and preview-before-send not done; not scheduled before the demo |

## Wave 5 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-8 `mobile` Playwright project + fixtures | P0 | done | QA | `5814c90`. Projects `desktop` / `mobile` (Pixel 7, fake mic flags, CDP long-press) |
| QA-9 Voice-note suite (API + magic-byte verification) | P0 | done | QA | `e2e/voice.spec.ts`; WAV fixture for bob; magic bytes now asserted as `OggS` on Chromium ("Voice format" below) |
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
| Waived | AC-V2-4 at the time; **met** since the "Voice format" change (see below) |

**Before the stakeholder demo** (carried over from Phase 1, still pending): restart the homeserver once (`npm run hs:down && npm run hs:up`) so the relaxed `rc_room_creation` limit applies; `npm run seed:reset` for the seeded badges; then follow docs/PHASE2_DEMO.md.

## Wave 6 device pass
| Item | Result |
|---|---|
| APK on the stakeholder's Android device, phone demo script 1-10 | not yet run (docs/PHASE2_DEMO.md) |
| Manual criteria (AC-C1-6, AC-M2-8, AC-M6-4/5, AC-V5-3) | not yet run |
| Mac handoff package (iOS) | prepared: `ios/` in the repo, steps in docs/MOBILE.md section 4 |
| AC-V2-4 (Ogg/Opus in Chromium) | **Met** (2026-10-18, "Voice format" below). Was waived by PM on 2026-10-04 after the PRIN-5 spike (native `MediaRecorder` container, `encodeToOggOpus` identity seam); the WebM -> Ogg remux that was P1 then has landed. AC-V2-2/V2-3 now assert `OggS` on Chromium. |

## Voice format (2026-10-18, branch `claude/voice-notes-format-*`)
Plan + criteria: docs/VOICE_FORMAT_PLAN.md (AC-F1..F13). Goal (JC): every voice note plays for every listener, including iPhones older than iOS 18.4.
| Item | Status | Owner | Notes |
|---|---|---|---|
| Lossless WebM/Opus -> Ogg/Opus remux on send, `audio/ogg` + `Voice message.ogg`, original sent on remux error | done | Principal + Dev A | `src/lib/audio/ogg.ts`, `encode.ts` seam, `useVoiceRecorder.ts`, `actions.ts`. AC-V2-4 met |
| Software decode fallback on play (`ogg-opus-decoder`, lazy) for browsers that can't play Ogg/WebM; old WebM notes remuxed in the browser first; iOS gesture unlock | done | Principal + Dev B | `src/lib/audio/softdecode.ts`, `wav.ts`, `VoiceMessage.tsx` (`data-playback="native\|fallback"`) |
| QA: AC-F tests in `e2e/voice.spec.ts`, fixtures `chromium-*.webm` | done | QA | 34 mobile tests: ogg-remux 4, voice-compat 12, voice 18 (AC-V1-2 level meter flaky in the cloud container, passes alone; untouched code) |
| AC-F13 real-device check on an iPhone < 18.4 (WebKit not runnable here) | todo | manual | docs/VOICE_FORMAT_PLAN.md |

## Requests to Principal (Phase 2)
| # | From | Request | Status |
|---|---|---|---|
| 7 | PM | Shared API per docs/PHASE2_TICKETS.md (layout store, Drawer, audio helpers, `sendVoiceMessage`, `getVoiceMessage`, CSS variables) | done (`0913d00`) |
| 8 | PM | Shell testids per docs/PHASE2_ACCEPTANCE.md (`data-layout`, `nav-drawer`, `member-drawer`, `drawer-backdrop`) | done (`0913d00`) |
| 9 | QA | `test:e2e:mobile`, `test:e2e:apk` script lines in `package.json` | done as `test:e2e:mobile`, `test:e2e:desktop`, `test:android-build` (`5814c90`) |

---

# Phase 3 - Threads

Plan: docs/PHASE3_PLAN.md · Criteria/testids: docs/PHASE3_ACCEPTANCE.md · Tickets: docs/PHASE3_TICKETS.md. Planned 2026-10-07 by PM (advisor consults 1-3 recorded in the plan); Waves 7-8 and the dry run below as of 2026-10-08 (working tree, uncommitted). P0 = the desktop and phone demo scripts. Waves: 7 Principal core (PRIN-8 first, QA gate right after), 8 devs + QA in parallel, 9 dry run + interop check. PM rulings G-1 (AC-A4-2 membership from the server) and G-2 (BUG-7; outcome: Dev B's tombstone fix, AC-T9-3 unmodified) are in docs/PHASE3_ACCEPTANCE.md "Rulings".

## Wave 7 - Principal
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| PRIN-8 `threadSupport: true`, bridge thread events, badge rule (`unreadByRoom` main-only), reply/display hygiene | P0 | done | Principal | `npm run verify:threads` 51/51; Phase 1 regression (shell + smoke) 11 pass / 4 fresh-seed skips / 0 fail; QA-17 gate green (below) |
| PRIN-9 Timeline source, `threadRoot` sends, thread pagination, `useThreadSummary`, `useRoomThreads`, `useThreadStore` | P0 | done | Principal | Names per ARCHITECTURE "Phase 3 deltas"; BUG-5 (`replyTo` + `threadRoot`) fixed: `sendText` throws `ThreadReplyConflictError` before sending, AC-T2-3 passes |
| PRIN-10 Thread panel container (desktop column swap, phone overlay, Android back) | P0 | done | Principal | |
| PRIN-11 `scripts/send-thread-sample.mjs` (`npm run thread:sample`) + ARCHITECTURE deltas | P0 | done | Principal | |
| PRIN-12 Seed threads in `#dev` | P1 | done | Principal | Applies on the next `seed:reset`; carol joins `#dev` as the seeded root author (ruling G-1) |

## Wave 8 - Dev A (navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-17 `header-threads` + unread dot + Threads list (popover / sheet) | P0 | done | Dev A | Replacement engineer (the original wrote `ThreadList.tsx` unmounted). AC-T7 7/7 desktop, 8/8 mobile with AC-T8; D-2 closed (`relativeTime.ts` deleted, `formatRelative` used) |
| DEV-A-18 Phone header while a thread is open (`header-back`, `Thread` title) | P0 | done | Dev A | AC-T7/T8 8/8 mobile |
| DEV-A-19 Threads list polish | P2 | partial | Dev A | Keyboard navigation in the list not done; not scheduled before the demo |

## Wave 8 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-18 `ThreadSummary` row under thread roots | P0 | done | Dev B | AC-T4 green |
| DEV-B-19 "Reply in thread" action (toolbar + long-press sheet) | P0 | done | Dev B | AC-T5 green |
| DEV-B-20 `ThreadView` (root, divider, list, composer, typing, receipts) | P0 | done | Dev B | BUG-6 re-filed as a test defect (baseline taken before `scrollTop = 0`; real drift 0.4 px; spec fixed, AC-T6-4 passes). Latent defect fixed: `usePagination` pinned while the list was shorter than the viewport and walked the panel off the newest reply; it now pins only when live geometry says the list is away from the bottom |
| DEV-B-21 Main-timeline and panel hygiene | P0 | done | Dev B | |
| DEV-B-22 In-thread edits, reactions, delete, voice notes, uploads | P1 | done | Dev B | BUG-7 fixed: read-only tombstone in `useRoomEvents`; AC-T9-3 passes unmodified. Residual: a reply redacted before the client loaded has no row |

## Wave 8 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-14 API helpers (`sendThreadReply`, `getThreads`, `getRelations`, threaded receipts) + fixtures + config | P0 | done | QA | Main-only receipt selection in `readReceiptOf`/`unreadFor`; `requireThreadUi` skips with `not-built` |
| QA-15 `e2e/threads.spec.ts` (desktop) | P0 | done | QA | 43 tests; thread criteria 33 pass, BUG-5/6/7 logged |
| QA-16 `e2e/mobile-threads.spec.ts` (phone) | P0 | done | QA | 14 tests; 8 pass / 6 not-built (AC-T7/T8 pending Dev A) |
| QA-17 Regression gate after PRIN-8 + demo step 11 in both smoke specs | P0 | done | QA | Gate green (below); `npm run test:e2e:threads` added |
| QA-18 docs/BUGS.md Phase 3 section | P1 | done | QA | BUG-5, BUG-6, BUG-7 |

## Phase 3 dry run (2026-10-08, dirty homeserver, Dev A header work still in progress)
| Item | Result |
|---|---|
| QA-17 regression gate after PRIN-8 (`threadSupport: true`) | `desktop` **87 pass / 1 fail / 8 skip**, `mobile` **58 / 0 / 0**: the flip did not regress Phase 1/2 (the one fail is the BUG-4 login-time tail, environment). |
| Final `desktop` project (Phase 1 + `threads.spec.ts` + smoke step 11) | **114 pass / 3 fail / 13 skip / 11 did-not-run**. The did-not-run block is the serial smoke cascade after BUG-4 (login over 10 s under suite load); passes alone. |
| Final `mobile` project (Phase 2 + `mobile-threads.spec.ts` + phone smoke step 11) | **65 pass / 2 fail / 7 skip**; both fails were flakes, hardened and re-verified (`voice.spec.ts` 18/18, `mobile-threads.spec.ts` 8 pass / 6 not-built). |
| **Final runs at HEAD** (dirty DB, after DEV-A-17/18 and the last two test-timing fixes: AC-T6-4 loading watch armed before the scroll; AC-T7-6 and smoke step 11 clear leftover thread unreads with an unthreaded receipt first) | `threads.spec.ts` desktop **42 pass / 0 fail / 1 skip** (AC-T3-5, device-only manual) · `mobile-threads.spec.ts` **14/14** · `smoke.spec.ts` desktop **8 pass / 4 fresh-seed skips** incl. both step 11 thread tests · `mobile-smoke.spec.ts` **12/12** incl. step 11. |
| **Phase 1/2 regression at HEAD** (dirty DB, #general at ~1,100 events) | `shell.spec.ts` + `navigation.spec.ts` desktop **34 pass / 0 fail / 1 fresh-seed skip** · `voice.spec.ts` + `mobile-nav.spec.ts` mobile **48/48** · `verify:phone` **38/38** · `conversation.spec.ts` desktop **25 pass / 3 skip / 23 fail**: 22 of the 23 are `withFullHistory` round-budget exhaustion (the room is now too deep to page back to the seeded first message within the budget; the test's own message says run `npm run test:e2e:fresh`), the 23rd was **BUG-8** (below). After the BUG-8 fix: AC-B3-2 and AC-B3-4 **3/3**, AC-T6-4 **4/4** (one flake directly after the heavy run). |
| BUG-8 (new, fixed, commit `4d61b55`) | AC-B3-2 drift of 23 px on a deep room: a short page left the top sentinel in view and fired a second `paginateBack` while the first *absolute* scroll restore was settling. Fix in `MessageList.tsx`: relative, self-correcting anchor (row viewport top, corrected each frame for 600 ms, survives a second page, yields to user scrolling) plus `overflow-anchor: none`. Thread summaries were measured and ruled out (synchronous from the server bundle). |
| Thread criteria | **All built and green** (AC-T7 7/7 desktop, AC-T7/T8 8/8 mobile; AC-T3-5 manual). **BUG-6** re-filed as a test defect (spec fixed, AC-T6-4 passes; a latent `usePagination` pin bug fixed alongside). **BUG-7** fixed (tombstone; AC-T9-3 passes). **BUG-5** fixed (`ThreadReplyConflictError`; AC-T2-3 passes). |
| APK | Rebuilt with threads: `android/app/build/outputs/apk/debug/app-debug.apk`, 9.3 MB, LAN homeserver URL baked (`cap:build:android:lan`). Stakeholder handoff: docs/PHASE3_DEMO.md. |
| Element Web interop (thread from alice visible as a thread for bob) | not yet checked (manual, Wave 9) |
| Open bugs | **BUG-4 only** (environment: login time right after a full suite run). BUG-5, BUG-7 fixed; BUG-6 was a test defect, spec fixed. |

## Requests to Principal (Phase 3)
| # | From | Request | Status |
|---|---|---|---|
| 10 | PM | Shared API per docs/PHASE3_TICKETS.md (`TimelineSource`, `useTimeline`, `threadRoot` sends, `useThreadSummary`, `useRoomThreads`, `useThreadStore`, `threadUnreadByRoom`, thread-aware relations) | done (PRIN-8/9; deltas in docs/ARCHITECTURE.md) |
| 11 | PM | Shell `data-thread-open` + `ThreadView` mounting per docs/PHASE3_ACCEPTANCE.md | done (PRIN-10) |
| 12 | PM | `thread:sample` script line in `package.json` | done (PRIN-11) |

---

# Phase 4 - GIF picker

Plan: docs/PHASE4_PLAN.md · Criteria/testids: docs/PHASE4_ACCEPTANCE.md · Tickets: docs/PHASE4_TICKETS.md. Planned 2026-10-09 by PM (advisor consults 1-4 recorded in the plan; the orchestrator's **hot-link** decision supersedes the brief's re-upload: Klipy forbids re-hosting or proxying its media). P0 = the desktop and phone demo scripts. Provider `mock` keyless; `klipy` once the stakeholder pastes a key (user-only steps in the plan). Waves: 10 Principal core (PRIN-13 first), 11 devs + QA in parallel, 12 dry run + Element link/preview check + APK with the key.

## Wave 10 - Principal
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| PRIN-13 `src/lib/gif/` abstraction, resolver, mock provider, fixture generator (`public/gif-fixtures/`) | P0 | done | Principal | mock + klipy providers, fixtures; verify:gif 30/30. Lands first: Dev A's grid and QA's fixture checks need the mock data |
| PRIN-14 `klipy` provider (path-segment key, search/trending, mapping, errors, abort) | P0 | done | Principal | customer_id sent, slug ids (BUG-9). No live probe without a key; mapping kept in one function |
| PRIN-15 `sendGif`, `getGifContent` (host allow list), image host allow list (CSP / Capacitor) | P0 | done | Principal | hot-link send, host allow list, registerBackHandler. AC-G3-5 has a manual Android WebView check |
| PRIN-16 `scripts/send-gif-sample.mjs` (`npm run gif:sample`), `.env.example`, MOBILE + ARCHITECTURE deltas | P1 | done | Principal | gif:sample defaults to #dev; .env.example, README, MOBILE, ARCHITECTURE deltas.  |

## Wave 11 - Dev A (GIF picker, `src/features/gif/**`)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-20 `GifPicker`: popover + sheet, search (300 ms debounce), trending, grid, states, attribution | P0 | done | Dev A | AC-G4 green (desktop 16/16 incl. keyboard, phone 6/6). BUG-10 (mock titles drifted from the contract) fixed by the mock-2/mock-3 rename |
| DEV-A-21 Keyboard navigation, selection, focus trap | P0 | done | Dev A | AC-G5 green |
| DEV-A-22 Load more, mp4 previews, aspect reservation | P1 | todo | Dev A | |
| DEV-A-23 Picker polish | P2 | todo | Dev A | Not scheduled before the demo |

## Wave 11 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-23 Slash commands (`/gif`, `/giphy`), `composer-gif`, mounting the picker | P0 | done | Dev B | verified by QA 16/16 + Dev A in-app pass; Dev B write-up pending. Any other `/text` must still send as text (S1 if swallowed) |
| DEV-B-24 Send flow: `gif-pending`, `sendGif`, error toast, one in flight | P0 | done | Dev B | gif-pending held 800 ms in AC-G7-3.  |
| DEV-B-25 `GifMessage` rendering: badge, offscreen unmount, reduced motion, fallback | P0 | done | Dev B | GifMessage states: playing/offscreen/paused/fallback. Image bytes come straight from `static.klipy.com` (or own origin under `mock`) |
| DEV-B-26 Thread composer + phone integration | P1 | done | Dev B | thread composer + phone sheet, Android back via registerBackHandler.  |

## Wave 11 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-19 Stubs (Klipy API + CDN), quota guard, provider override, `sendGifMessage`, fixture checks | P0 | done | QA | Quota guard in the shared fixture; BUG-9 (S3) filed: Klipy numeric ids above 2^53, fixed by using `slug` as `GifResult.id` |
| QA-20 `e2e/gif.spec.ts` (desktop) | P0 | done | QA | `e2e/gif.spec.ts` desktop **16/16** |
| QA-21 `e2e/mobile-gif.spec.ts` (phone) | P0 | done | QA | `e2e/mobile-gif.spec.ts` phone **6/6** |
| QA-22 Demo step 12 in both smoke specs + final runs | P0 | done | QA | Smoke step 12 passes in both `smoke.spec.ts` and `mobile-smoke.spec.ts` |
| QA-23 docs/BUGS.md Phase 4 section | P1 | todo | QA | |

## Phase 4 dry run
| Item | Result |
|---|---|
| `desktop` / `mobile` projects incl. `gif.spec.ts`, `mobile-gif.spec.ts`, smoke step 12 | Done at bf3ba3b: `gif.spec.ts` 16/16, `mobile-gif.spec.ts` 6/6, smoke step 12 green in both projects; regression shell+nav+threads 76 pass/2 skip, voice+mobile-nav+mobile-threads 61 pass + 1 load flake (AC-T6-2 phone, passes alone), verify:phone 38/38, verify:gif 30/30. APK rebuilt (mock provider, no key). Bugs: BUG-10 (title drift, fixed), BUG-9 (S3, slug ids, fixed) |
| Stakeholder's Klipy key tried by hand (search, trending, send, Element link + URL preview) | pending the key |
| APK rebuilt with the key | pending the key |
| Manual criteria (AC-G3-5 WebView image load, AC-G9-2 Android back) | not yet run |

## Requests to Principal (Phase 4)
| # | From | Request | Status |
|---|---|---|---|
| 13 | PM | Shared API per docs/PHASE4_TICKETS.md (`src/lib/gif/`, `sendGif`, `getGifContent`, `window.__poc.gif`, image host allow list, fixtures) | todo |
| 14 | PM | `gif:fixtures`, `gif:sample` script lines in `package.json`; `.env.example` `VITE_GIF_API_KEY` | todo |

---

# Phase 5 - End-to-end encryption

Plan: docs/PHASE5_PLAN.md · Criteria/testids: docs/PHASE5_ACCEPTANCE.md · Tickets: docs/PHASE5_TICKETS.md · Handoff: docs/PHASE5_DEMO.md. Planned 2026-10-17 by PM (Advisor risk list + consults 1-3 recorded in the plan). Scope: `e2ee-plan.md` items 1-7. P0 = the desktop demo script (three browser windows against the local Synapse). Real-server pass on 704.chat (SSO, Element interop, existing recovery keys) is manual, Wave 15. Rules this phase: never `seed:reset`, two browser contexts max, keys never survive logout. Waves: 13 Principal core (PRIN-17/18 first), 14 devs + QA in parallel, 15 dry run + regression + 704.chat checklist.

## Wave 13 - Principal
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| PRIN-17 Crypto boot (`initRustCrypto` per user+device), wipe on logout / token rejection, `useSecurityStore` skeleton, loading stage, dev hook | P0 | in-progress | Principal | `src/lib/matrix/crypto.ts`, `security.ts`, `src/store/security.ts`, Vite `optimizeDeps.exclude` landed in the working tree while planning; docs realigned to those names |
| PRIN-18 Timeline decryption: bridge `Decrypted`, `getDecryptionState`, `isDisplayableEvent` keeps `m.room.encrypted`, `prepareToEncrypt`, `isRoomEncrypted` | P0 | in-progress | Principal | `getDecryptionState` / `describeDecryptionFailure` in `utils.ts` (working tree) |
| PRIN-19 Encrypted attachments (`attachments.ts`, decrypted media helpers, encrypted `sendFile` / `sendVoiceMessage`) | P0 | in-progress | Principal | `attachments.ts` (working tree); no server thumbnails for encrypted media |
| PRIN-20 Verification + cross-signing core (SAS both ways, bootstrap with UIA); **SSO UIA spike on 704.chat first** | P0 | todo | Principal | Least certain piece (Advisor risk 5); result goes into ARCHITECTURE |
| PRIN-21 Recovery + backup core (unlock with key / passphrase, restore, setup guarded by existing SSSS) | P0 | todo | Principal | Cross-signing before secret storage; `cryptoCallbacks` mandatory |
| PRIN-22 Encrypted by default, `#vault` seed, `e2ee:sample`, `verify:e2ee` | P0 | todo | Principal | `npm run seed` once (idempotent), never `seed:reset`; sample script exports keys to `seed/e2ee-keys.json` |
| PRIN-23 Shell mounts, `current-user[data-verified]`, ARCHITECTURE "Phase 5 deltas", MOBILE note | P1 | todo | Principal | |

## Wave 14 - Dev A (security UI `src/features/security/**`, navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-24 `SecurityBanner` + `SecurityDialogs` host + `openSecurityDialog` | P0 | todo | Dev A | Banner from `useSecurityHint()`; one dialog at a time |
| DEV-A-25 `VerificationDialog` (outgoing + incoming, 7 emoji, match / mismatch / cancel) | P0 | todo | Dev A | |
| DEV-A-26 `RecoveryDialog` + `SetupEncryptionDialog` (key or passphrase; UIA prompt; key shown once) | P0 | todo | Dev A | Setup only reachable when `hint === 'setup'` |
| DEV-A-27 `channel-header-lock`, `data-encrypted` on items, notes in the create dialogs | P0 | todo | Dev A | |
| DEV-A-28 Phone variants (sheets, 44 px, banner on phone) | P1 | todo | Dev A | |
| DEV-A-29 Sessions list | P2 | todo | Dev A | Not scheduled before the demo |

## Wave 14 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-27 Undecryptable / decrypting rows with reasons + actions; late decryption re-render | P0 | todo | Dev B | `data-reason` derived from `decryption.code` (mapping in the tickets) |
| DEV-B-28 Encrypted images, files, voice notes in rows (decrypt in view, blob URLs, errors) | P0 | todo | Dev B | Never navigate to a raw encrypted mxc |
| DEV-B-29 Composer in encrypted rooms (`prepareToEncrypt`, placeholder, send errors) | P0 | todo | Dev B | |
| DEV-B-30 Edits, replies, reactions, threads, redactions verified in `#vault` | P0 | todo | Dev B | |
| DEV-B-31 GIF click-to-load in encrypted rooms | P1 | todo | Dev B | |

## Wave 14 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-24 `e2e/fixtures/e2ee.ts` (second context, setup / verify / unlock helpers, wire + ciphertext checks), config, `test:e2e:e2ee` | P0 | todo | QA | |
| QA-25 `e2e/e2ee-core.spec.ts` (AC-E1, AC-E2, AC-E6) | P0 | todo | QA | |
| QA-26 `e2e/e2ee-media.spec.ts` (AC-E3) | P0 | todo | QA | |
| QA-27 `e2e/e2ee-security.spec.ts` (AC-E4, AC-E5, two contexts) | P0 | todo | QA | |
| QA-28 Smoke step 13 (demo 1-11) + regression runs | P0 | todo | QA | |
| QA-29 docs/BUGS.md Phase 5 + 704.chat manual checklist | P1 | todo | QA | |

## Phase 5 dry run
| Item | Result |
|---|---|
| `desktop` / `mobile` projects incl. the three e2ee specs and smoke step 13 | not yet run |
| SSO UIA cross-signing spike on 704.chat (PRIN-20) | not yet run |
| Manual 704.chat pass (JC, Charlie, Juanjo): verify against Element both ways, unlock with the existing recovery key, read the 6 encrypted rooms, codec media decrypted by Element, new-account setup over SSO | not yet run |
| Open bugs | BUG-4 (S3, environment) carried over |

## Requests to Principal (Phase 5)
| # | From | Request | Status |
|---|---|---|---|
| 15 | PM | Shared API per docs/PHASE5_TICKETS.md (`useSecurityStore`, `getDecryptionState`, attachments + decrypted media helpers, `prepareToEncrypt`, `isRoomEncrypted`, Shell hosts, dev hook with `importRoomKeys` / `exportRoomKeys`) | in-progress (store, crypto, attachments in the working tree) |
| 16 | PM | `#vault` in `seed.ts` + `rooms.vault` in `seed-output.json`; `e2ee:sample`, `verify:e2ee`, `test:e2e:e2ee` script lines | todo |
| 17 | PM | After the 704.chat spike: the SSO UIA prompt shape on `useSecurityStore.prompt` (so DEV-A-26's `setup-sso-hint` has a contract) | todo |


---

# Phase 6 - Link preview cards

Plan: docs/PHASE6_PLAN.md · Criteria/testids: docs/PHASE6_ACCEPTANCE.md · Tickets: docs/PHASE6_TICKETS.md. Planned 2026-10-18 by PM from the orchestrator's settled brief (no Advisor consult needed). Scope: cards (site, title, description, image) for up to 3 links per message in plain rooms, **click-to-load in encrypted rooms** (no `preview_url` request before the click), hide per viewer, quiet errors, in-memory cache, cards in threads, YouTube / Spotify embeds as P1 (cut first). P0 = the desktop demo script (alice in `#dev` and `#vault` against the local Synapse with the test whitelist). Waves: 16 plan + core, 17 features + tests, 18 fix wave + regression.

## Wave 16 - PM + Principal
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| PM docs (plan, acceptance, tickets, this section) | P0 | done | PM | Aligned to the shipped `src/lib/preview/` names and fixtures; QA's measured-dimensions correction applied |
| PRIN-24 `src/lib/preview` core (extraction, normalisation, `getLinkPreview` LRU 200 / 1 h / 5 min + dedupe, `shouldAutoPreview` / `getPreviewUrls`, hidden store, hooks, `__matrixPoc.preview`) | P0 | done | Principal | Cache cleared on logout / token rejection (request #20); BUG-30 fixed (the SDK's own per-minute `urlPreviewCache` kept answering after `clearLinkPreviewCache()`) |
| PRIN-25 Test whitelist `127.0.0.1/32` + `::1/128`, `public/preview-fixtures/*` + `preview:fixtures`, ARCHITECTURE "Phase 6 deltas (link previews)" | P0 | done | Principal | Pool build port moved 8030 -> 8040; snapshot rebuilt for the runs |
| PRIN-26 `parseEmbed` edge cases | P1 | done | Principal | Folded into the core |

## Wave 17 - Dev A (`src/features/link-preview/**`)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-30 `LinkPreviewCard` (states, large / thumbnail / text, reserved box, hide, phone full width via `useIsPhone()`) | P0 | done | Dev A | `onEmpty(url)` prop added so the host can drop empty cards |
| DEV-A-31 `EmbedPlayer` (play -> sandboxed iframe, nocookie) | P1 | done | Dev A | No third-party request before the click |
| DEV-A-32 Keyboard + reduced motion | P2 | partial | Dev A | Escape on the hide button not done; carried over |

## Wave 17 - Dev B (conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-32 `link-previews` host under `message-body`, main list + thread panel, edits, redactions | P0 | done | Dev B | Host drops URLs that report `onEmpty`, so `data-count` matches the visible cards |
| DEV-B-33 Encrypted click-to-load switch (`shouldAutoPreview`) | P0 | done | Dev B | Zero `preview_url` calls before a click |
| DEV-B-34 Scroll stability with growing cards | P0 | done | Dev B | Scroll observer re-pins while stuck to the bottom |

## Wave 17 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-30 `e2e/fixtures/link-preview.ts`, guards, `test:e2e:link-preview` | P0 | done | QA | |
| QA-31 `e2e/link-preview.spec.ts` (desktop) | P0 | done | QA | BUG-30 regression included |
| QA-32 `e2e/mobile-link-preview.spec.ts` (phone) | P0 | done | QA | |
| QA-33 Regression runs, docs/BUGS.md "Phase 6", regression test per fix | P0 | done | QA | |

## Phase 6 dry run (Wave 18)
| Item | Result |
|---|---|
| Full run 3, both projects (`desktop` + `mobile`, incl. the two link-preview specs) | **326 passed, 0 failed, 10 skipped** |
| Desktop + phone demo scripts (docs/PHASE6_PLAN.md) | Covered by the specs; no manual blockers reported |
| Homelab Synapse check by JC (previews enabled, `lxml` present, blacklist kept) | user-only; prompt from the orchestrator |
| Open follow-up | AC-E6-3 (Phase 5) fails when run **alone** on a fresh server: ordering dependency in the e2ee boot spec, green in the full run; to be made self-contained. DEV-A-32 Escape-on-hide not done. BUG-4 (S3, environment) carried over |

## Requests to Principal (Phase 6)
| # | From | Request | Status |
|---|---|---|---|
| 18 | PM | Shared API per docs/PHASE6_TICKETS.md (`@/lib/preview`), cache numbers + module map in ARCHITECTURE | done |
| 19 | PM | `url_preview_ip_range_whitelist` in the test configs + `public/preview-fixtures/*`; pool snapshot rebuild | done |
| 20 | PM | `clearLinkPreviewCache()` on logout / token rejection | done |

---

# Phase 7 - Voice calls (product "voice Phase 1", MVP)

Plan: docs/PHASE7_PLAN.md · Criteria/testids + manual 704.chat checklist: docs/PHASE7_ACCEPTANCE.md · Tickets: docs/PHASE7_TICKETS.md. Planned 2026-10-18 by PM from `matrix-poc/voice-calls/PLAN.md` (Advisor rulings recorded there; PM doubts and the Advisor's Wave 19 rulings in `voice-calls/working/advisor-questions.md`, applied to the docs the same day: keys reach unverified devices so the hint is "No call keys from X yet"; Codec builds and parses the ring with explicit `m.mentions.user_ids`; exact js-sdk 43 event names; `joinRTCSession`; LiveKit 1.13.10 and lk-jwt-service 0.9.0 pins; third context only for the three named tests). Orchestrator ruling on chat lines applied the same day: `started` from the ring / first membership, `declined` via `org.matrix.msc4310.rtc.decline` (+`io.codec.decline_reason: busy`), `ended` + `missed` via one encrypted `dev.matrixpoc.call` `{ kind, call_id, duration_ms?, participants? }`; history is the room's, localStorage only a cache. Scope: encrypted voice calls on MatrixRTC + self-hosted LiveKit, DMs ring, rooms ring at <= 5 members else drop-in (orchestrator default, JC can change), Android foreground service in scope, ring-when-closed / voice channels / video out. P0 = the desktop demo script (two windows, local Synapse + local LiveKit, fake mic). Homelab server install is product Phase 0 (JC via Hubot). Waves: 19 Principal core (PRIN-27 first, PRIN-28 gate run by QA right after), 20 devs + QA in parallel with the Principal on Android, 21 regression + fix wave + manual 704.chat checklist.

## Wave 19 - Principal
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| PRIN-27 Local RTC dev stack (binary LiveKit + Node jwt port per Synapse, Synapse flags, well-known `rtc_foci`, pool wiring, `rtc:probe`, `calls-core.spec.ts`) | P0 | in-progress | Principal | `rtc-stack.mjs`, `lk-jwt.mjs`, `rtc.mjs`, `hs.mjs` / `hs-pool.mjs` wiring, `homeserver.yaml` flags + well-known, `livekit-token.ts`, the `rtc:*` and `test:e2e:calls` script lines landed in the working tree before planning (docs aligned to them, no Docker needed). Left per Advisor Q7: `LIVEKIT_VERSION` 1.9.4 -> 1.13.10. Lands first; QA's `requireRtc` and both devs need it |
| PRIN-28 livekit-client 2.23 + E2EE worker bundling; js-sdk stays 43 (`m.call.member`, `/sfu/get`; 44 bump deferred, recorded in ARCHITECTURE); e2ee + threads suites green | P0 | todo | Principal | `livekit-client` already in `package.json`; orchestrator runs `npm install`; QA-38 gate run right after |
| PRIN-29 `src/lib/rtc/**` `CallSession` (membership, token, focus, LiveKit, E2EE keys, delayed leave, reconnect, mic) | P0 | todo | Principal | |
| PRIN-30 `src/store/call.ts`, bridge events, `policy.ts`, `lines.ts` (`dev.matrixpoc.call`), `previewText`, ringtone, multi-device, busy, timeout | P0 | todo | Principal | Store shapes frozen by day 3 for Dev B |
| PRIN-31 Android foreground service (Capawesome 7.0.1), manifest, speakerphone shim, real-phone lock-screen check, MOBILE.md | P0 | todo | Principal | Wave 20 |
| PRIN-32 Shell hosts (`call-host`, `data-in-call`, back order), `__matrixPoc.call`, ARCHITECTURE "Phase 7 deltas" | P0 | todo | Principal | |
| PRIN-33 Bridge detection (`m.bridge`, `@signal_*`), `canCall` bridged reasons | P1 | todo | Principal | First P1 to cut; the Signal bridge lands after this phase |

## Wave 20 - Dev A (navigation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-A-33 Header: mount `CallButton`, `header-join-call` chip, phone fit | P0 | done (pending Dev B's module) | Dev A | `ChannelHeader.tsx` imports `CallButton` from `@/features/call` (typecheck fails until DEV-B-35 lands it); chip from `useRoomCallSummary`, `data-count` = users, click `joinCall`, 44 px tap target on phone |
| DEV-A-34 Sidebar `room-call-indicator`, missed-call red preview | P0 | done | Dev A | `RoomCallIndicator.tsx`, `hooks/useRoomCall.ts`, `callPreview.ts` (+ unit test); rows only get preview text while missed (no general previews in rows) |
| DEV-A-35 Chip tooltip, aria, keyboard | P2 | done | Dev A | Chip `title` "In voice: names", indicator `aria-label` "n in voice", chip focus ring; DOM order = tab order (call button, chip, threads, members) |

### Requests to Principal (Phase 7)
| From | Request | Fallback in place |
|---|---|---|
| Dev A | (resolved) `getCallLine` / `isMissedForViewer` landed in `src/lib/rtc/lines.ts`; `callPreview.ts` imports them directly (relative, so the unit test loads) | - |
| Dev A | `isDisplayableEvent` / `isMainTimelineEvent` accept the three call line types, so "last row" agrees with the timeline | `callPreview.ts` treats ring / decline / `dev.matrixpoc.call` as rows itself |

## Wave 20 - Dev B (`src/features/call/**` + conversation)
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| DEV-B-35 `CallButton` (modes, disabled reasons, bridged hint, mic-denied toast) | P0 | todo | Dev B | |
| DEV-B-36 `IncomingCallCard` (Accept / Decline, ringtone gate, title flash, auto-close, phone + vibration) | P0 | todo | Dev B | |
| DEV-B-37 `CallScreen` + `InCallBar` (tiles, timer, lock, states, controls, desktop panel / phone full screen) | P0 | todo | Dev B | |
| DEV-B-38 Timeline call lines `message-call` + `call-back` | P0 | todo | Dev B | |
| DEV-B-39 Phone: Android back, speaker wiring, keyboard vs bar, 56 px | P1 | todo | Dev B | |

## Wave 20 - QA
| Ticket | P | Status | Owner | Notes |
|---|---|---|---|---|
| QA-34 `e2e/fixtures/call.ts` (`requireRtc`, `cleanupCalls`, contexts, `ringAlice`, stubs), `test:e2e:call` | P0 | todo | QA | |
| QA-35 `e2e/call-dm.spec.ts` (desktop) | P0 | todo | QA | Multi-device tests open a third context, serial |
| QA-36 `e2e/call-room.spec.ts` | P0 | todo | QA | Bridged rows are P1 |
| QA-37 `e2e/mobile-call.spec.ts` + smoke step 14 in both smoke specs | P0 | todo | QA | |
| QA-38 Gate run after PRIN-28, regression runs, docs/BUGS.md "Phase 7" + manual checklist table, regression test per fix | P0 | todo | QA | |

## Wave 21 - fix wave (QA run 1 of Wave 20, docs/BUGS.md "Phase 7")
| Bug | S | Status | Owner | Notes |
|---|---|---|---|---|
| BUG-33 Ringtone never starts when the ring arrives before any gesture (AC-R5-1) | S2 | in-progress | Principal | `ringtone.play()` called once from the store; needs a retry on the first gesture |
| BUG-34 `ended` line has no `participants` (AC-R3-6, AC-R6-6) | S2 | in-progress | Principal | `buildCallLineContent` / `sendEndLines` |
| BUG-35 Caller hangs up while ringing: no `missed` line (AC-R5-4) | S2 | in-progress | Principal | `sendEndLines` only covers the timeout |
| BUG-36 Started row reads "started a call" (AC-R7-1) | S3 | in-progress | Principal | Text is "started a voice call"; sender's own device says "You" (orchestrator ruling) |
| BUG-37 Mic-denied toast shown twice (AC-R4-5) | S3 | in-progress | Dev B | `CallErrorToast` effect under StrictMode |

Orchestrator rulings from QA's contract review (docs/PHASE7_ACCEPTANCE.md updated): the sender's own device says "You" on every call line; a drop-in start sends no ring event (AC-R3-2); `call-close` added to the registry.

## Phase 7 dry run (Wave 21)
| Item | Result |
|---|---|
| Gate run after `livekit-client` + worker bundling (`desktop`, `mobile`, `test:e2e:e2ee`, `test:e2e:threads`) | not yet run |
| Full runs incl. `test:e2e:call` and smoke step 14, both projects | Fix wave `41169c9`, 3 workers, 22.5 min: **368 passed / 1 failed / 10 skipped**. Red: AC-R4-5 (BUG-37: still two mic-denied toasts, store sets `lastError` twice; Principal). Call specs 21/22; smoke step 14 green on both projects. BUG-33..36 closed (docs/BUGS.md Phase 7). Earlier: Wave 2 `7f5bf37` 360 / 5 / 12 |
| Desktop demo script 1-9 (docs/PHASE7_PLAN.md) | not yet run |
| Android: AC-R9-2/4/5 on a real phone (PRIN-31) | not yet run |
| Manual 704.chat checklist M1-M15 (JC, Charlie, Juanjo; needs product Phase 0 on the homelab) | not yet run |
| Open bugs | BUG-33..37 (Wave 21 table above, all in progress); BUG-4 (S3, environment) carried over; AC-E6-3 green after its test-order fix |

## Requests to Principal (Phase 7)
| # | From | Request | Status |
|---|---|---|---|
| 21 | PM | Shared API per docs/PHASE7_TICKETS.md (`src/lib/rtc/**`, `useCallStore` + hooks, `getCallLine` / `previewText`, ringtone, `native.ts` call service, Shell `call-host`, `__matrixPoc.call`) | todo |
| 22 | PM | Local call stack wired into `hs.mjs` / `hs-pool.mjs`, Synapse flags, well-known `rtc_foci`, `rtc:*` script lines; pool snapshot rebuild by the orchestrator | done in the working tree (probe behaviour and `E2E_NO_RTC` messages per AC-R1-3/4 still to check) |
| 23 | PM | Store shapes (`activeCall`, `incoming`, `liveByRoom`) frozen by Wave 19 day 3, with a mock state setter on `__matrixPoc.call` so Dev B can build the screens before the core connects | todo |
| 24 | QA | Ring timeout override for the e2e 60 s cases: `__matrixPoc.call.setRingTimeoutMs(ms)` (or `__matrixPoc.calls.…`) that the store passes to new `CallSession`s (`ringTimeoutMs`: ring `lifetime`, no-answer timer, `missed` send) and to `watchIncomingCalls` (incoming expiry cap); dev builds only, reset on reload. `e2e/fixtures/call.ts` `ringTimeoutOverride()` already calls it when present | todo (fallback: the missed-call test in `call-dm.spec.ts` runs the real 60 s, annotated `real-time`) |
