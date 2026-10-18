# Phase 7 Plan: voice calls (product "voice Phase 1", the MVP)

Phases 1-6 shipped the client, phone layout and APK, voice notes, threads, GIFs, E2EE and link previews. Phase 7 adds **encrypted voice calls**: ring someone from a DM, start or join a voice call in a room, on web and in the Android app while Codec is open. Source: `matrix-poc/voice-calls/PLAN.md` (agreed by PM, Principal and Advisor; **Codec is the only client this phase**). Tickets: docs/PHASE7_TICKETS.md. Criteria, testids and the manual 704.chat checklist: docs/PHASE7_ACCEPTANCE.md. Status: docs/STATUS.md "Phase 7". Homelab server work (LiveKit, ports, Synapse upgrade) is the product plan's Phase 0, done by JC via Hubot, not a ticket here.

## Goals
1. **Call from a DM, talk, hang up**: tap the phone icon, the other person's open Codec rings, Accept, both hear each other, "Call ended, 5 min" in the chat.
2. **Room calls**: a green "Join voice (2)" chip when someone is in a call; small rooms ring, big rooms are drop-in.
3. **Nobody but the participants hears it**: MatrixRTC + self-hosted LiveKit with per-participant media keys over the Phase 5 crypto stack; the lock is on the call screen; calls are refused where they cannot be encrypted.

## Product decisions
| Topic | Decision |
|---|---|
| Stack | MatrixRTC (`MatrixRTCSession` in matrix-js-sdk **43, kept**: the Principal's `src/lib/rtc/livekit-token.ts` targets lk-jwt-service's legacy `/sfu/get` with `org.matrix.msc3401.call.member` state events and identity `userId:deviceId`, which lk-jwt-service **0.9.0** (the homelab pin, Advisor Q6) still serves; the 44 bump and MSC4195 `/get_token` are deferred until needed) + `livekit-client` 2.23 with the E2EE worker; `livekit-server` **1.13.10** pinned on both sides (Advisor Q7); single SFU, no sticky events (Advisor B1). Codec builds and parses the ring event itself (`org.matrix.msc4075.rtc.notification` with explicit `m.mentions.user_ids`, Advisor Q5/F2). Focus discovery: authenticated unstable `/rtc/transports`, then well-known `org.matrix.msc4143.rtc_foci` (Advisor B2). Not the legacy 1:1 `m.call.invite` stack. |
| DMs | Always ring: phone icon in the header rings the other person on every device where Codec is open. 60 s with no answer = missed. Already in a call = the caller sees "Busy". |
| Rooms (**default, JC can change**) | Codec has no per-person client-style setting yet (checked: nothing in `src/store/layout.ts` or `bridge.ts`), so one behaviour for everyone, Discord-style with a small-room ring rule: the header always shows a **Join voice (n)** chip when a call is live; the phone icon starts a call and **rings every member when the room has 5 or fewer joined members** (`CALL_RING_MAX_MEMBERS = 5`, ghosts and self excluded), otherwise it just starts the session (chip, sidebar speaker icon, no ring). A per-person style switch (PLAN.md's two columns) is a later phase and plugs into `ringPolicy()`. |
| Who may start (**default**) | Anyone in the room. |
| Ring when closed | **Out** (push, product Phase 2). A call reaches you if Codec is in the foreground or a tab is open on at least one device. Once in a call, it survives screen lock and backgrounding on Android (foreground service, in scope). |
| Multi-device | Rings every device of the callee; answering (or declining) on one stops the others. Client logic, not spec (Advisor C3). |
| In the call | Avatar grid, green outline on the speaker, crossed mic on muted people, timer, lock, connection warning; controls Mute, Speaker/earpiece (phone), Leave. Leaving the screen keeps the call going behind a slim **in-call bar**. One active call at a time; joining another leaves the first. |
| Ending | Leave ends your part; a 1:1 call ends for both when either leaves; a room call stays up until empty. |
| Chat lines | Grey lines "X started a voice call" / "Call ended, 12 min" / "X declined" / "Missed call from X" (red tint, **Call back**). A missed call is the room's last-message preview with an unread badge. "Started" is read from the ring (or the first membership of a drop-in call), "declined" from the standard decline event (`org.matrix.msc4310.rtc.decline`, busy flagged with `io.codec.decline_reason`), "ended" and "missed" from one Codec event `dev.matrixpoc.call` (orchestrator ruling; contract in docs/PHASE7_ACCEPTANCE.md). History lives in the room, so every device shows the same lines. |
| Encryption | Media keys only through the Phase 5 crypto; calls are **refused in unencrypted rooms** (button disabled, "Calls need an encrypted room"), no silent fallback (Advisor C5). Media keys reach every known device, verified or not (Advisor Q2); a participant whose keys have not arrived within 5 s shows "No call keys from X yet" instead of silence. The lock means "media is E2EE to the SFU", not "all devices verified". |
| Mic | Requested only on start/accept; released on leave. Denied = a clear message with a "how to allow" hint, nothing half-started. |
| Signal bridge (**default**) | Calls never cross the bridge. DM whose only other member is a bridge ghost: phone icon **hidden**. Bridged group: calls work, chip reads **Codec members only**. Detection from the `m.bridge` state event / `@signal_*` ghosts (not built yet; P1 helper, the bridge lands after this phase). |
| Web ringtone | Plays only once the tab has been clicked (browser rule); otherwise the card plus a flashing tab title. |
| Privacy | Never recorded. Server sees who called whom and when, never audio. |

## In scope
| Area | Owner | Deliverable |
|---|---|---|
| Local RTC dev stack | Principal | Pinned `livekit-server` 1.13.10 binary (no Docker, loopback only) + the Node port of lk-jwt-service, one stack per Synapse (`scripts/rtc.mjs`, `scripts/lib/rtc-stack.mjs`, `lk-jwt.mjs`, pool wiring, Synapse flags and well-known `rtc_foci`: landed), `npm run rtc:probe`, `e2e/calls-core.spec.ts` |
| Call core | Principal | `livekit-client` + E2EE worker bundling, `src/lib/rtc/**` (`livekit-token.ts` landed) (`CallSession`: session, token, LiveKit room, E2EE keys, delayed leave, reconnect), `src/store/call.ts` (`useCallStore`, ring policy, incoming, multi-device, busy, timeout, call lines, `previewText`), ringtone helper, shell hosts, `__matrixPoc.call` |
| Android | Principal | Foreground service (Capawesome 7.0.1, type microphone), manifest permissions, speakerphone shim, lock-screen check on a real phone, docs/MOBILE.md |
| Navigation | Dev A | Header **Join voice (n)** chip and the mount of Dev B's `CallButton`; sidebar speaker icon + count on rooms with a live call; missed-call preview styling |
| Call UI + conversation | Dev B | `src/features/call/**` (new): `CallButton`, `IncomingCallCard`, `CallScreen`, `InCallBar`; in `conversation/**`: timeline call lines with Call back |
| QA | QA | `e2e/fixtures/call.ts`, `call-dm.spec.ts`, `call-room.spec.ts`, `mobile-call.spec.ts`, regression runs, docs/BUGS.md "Phase 7" incl. the manual 704.chat checklist |

## Out of scope
Ringing while Codec is closed or backgrounded (push, product Phase 2) · voice channels in the sidebar (Phase 3) · video, screen share (Phase 4) · a per-person client-style setting · iOS, CallKit · Bluetooth routing menu · noise suppression, push-to-talk, recording, transcripts · interop with Element / Element X · calls in unencrypted rooms · a "Calls" tab · the homelab server install (JC via Hubot, product Phase 0).

## Desktop demo script (two Chrome windows, local Synapse + local LiveKit, fake mic allowed)
Prep: `npm run hs:up` (now also starts LiveKit + jwt), `npm run dev`, window 1 alice, window 2 bob (second profile), both verified (Phase 5), DM alice/bob open in both.

| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Window 1: click the phone icon in the DM header | A call screen with bob's avatar, "Calling...", the lock, Mute / Leave; window 2 shows a full-screen card "alice is calling", ringtone (after one click in the tab), Accept / Decline. |
| 2 | Window 2: Accept | Both windows: "Connected", timer running, two avatars; speaking one side outlines the other side's avatar green (fake mic = a tone). |
| 3 | Window 1: Mute | Crossed mic on alice's avatar in both windows. |
| 4 | Window 2: click the chat behind the call screen, type a message | The message sends; a slim bar "In call 00:4x, tap to return" stays above the composer; clicking it reopens the screen. |
| 5 | Window 1: Leave | Both call screens close; the DM shows "alice started a voice call" and "Call ended, 1 min". |
| 6 | Window 2: phone icon; window 1: Decline | Window 2 shows "bob declined"; the line "bob declined" is in the chat on both sides. |
| 7 | Window 2: phone icon; window 1: ignore for 60 s | Window 2: "No answer"; window 1: red "Missed call from bob" with **Call back**; the DM row in the sidebar reads "Missed call" with a badge. |
| 8 | Window 1: open `#vault` (encrypted, 3 members), phone icon | Everyone is rung (<= 5 members); window 2 accepts; the header in both shows "Join voice (2)" for anyone else and the sidebar row has a speaker icon with `2`. Leave from one side: the other stays in the call until they leave. |
| 9 | Window 1: open `#general` (unencrypted) | The phone icon is disabled, tooltip "Calls need an encrypted room". |

Phone script (Android, real device): docs/PHASE7_ACCEPTANCE.md "Manual 704.chat checklist" steps 1-6 double as the phone demo.

## Sequence
| Wave | Who | Output |
|---|---|---|
| 19 | Principal | PRIN-27 dev stack first (QA and devs need a LiveKit to talk to), then PRIN-28 (livekit-client + worker, gate run) and PRIN-29/30 (core + store) against the Shared API table; PRIN-32 shell hosts + dev hook. Devs start P0 UI against the table from day 1 with the store's mock state. |
| 20 | Dev A, Dev B, QA in parallel; Principal on Android | DEV-A-33/34, DEV-B-35..38, QA-34..37; PRIN-31 foreground service + device check; PRIN-33 bridge helper (P1). |
| 21 | All | QA-38 regression runs (`desktop`, `mobile`, e2ee suites unchanged), fix wave with a regression test per fix, manual 704.chat checklist by JC, Charlie and Juanjo, docs/STATUS.md final. |

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Homelab media path (CGNAT / blocked UDP) | No calls from outside the house | Product Phase 0 answers it before Wave 20 ends; fallback is a €5 VPS for LiveKit. Not a client ticket. |
| Staying on js-sdk 43 means the older MatrixRTC surface (`org.matrix.msc3401.call.member`, `/sfu/get`) | A later lk-jwt-service drops `/sfu/get`, or 43's session layer has bugs 44 fixed | 0.9.0 keeps the route, deprecated with no removal date (Advisor Q6); 43.0.0 already has the delayed-leave fixes; pin lk-jwt-service 0.9.0, LiveKit 1.13.10 and livekit-client 2.23 together; using `joinRTCSession` makes the 44 bump mechanical, recorded in ARCHITECTURE. PRIN-28 still runs the e2ee + threads suites after `livekit-client` and the worker bundling land. |
| Local Node port of lk-jwt-service drifts from the real one | Works locally, fails on 704.chat | Same routes, bodies, identity and room-name derivation (`livekit-token.ts`); the manual checklist is the proof against the real service. |
| Media keys arrive late or not at all (device list not downloaded, to-device send failed, receiver's crypto not ready) | A call that connects but stays silent | Core surfaces `keyState` per participant (5 s timeout); the tile says "No call keys from X yet"; verification is not a call prerequisite (Advisor Q2). |
| The local stack is loopback only and a native binary per OS | No LAN phone against the local stack; a box without the pinned binary has no calls | Phones test against the homelab stack (checklist); `LIVEKIT_SERVER_BIN` for a hand-installed binary; `requireRtc` skips the call suites with `not-available`, `E2E_NO_RTC=1` runs everything else. |
| Android background freezes the WebView | Call drops on screen lock | Foreground service of type `microphone`, started on Accept/Join while visible (Android 14 rule), stopped on Leave; real-phone check in PRIN-31. |
| Web autoplay rule | Silent incoming call | Ringtone gated on a prior user gesture; card + flashing title always; documented for testers. |
| Three browser contexts for the multi-device test | Memory on the test machine | One serial test, contexts closed in `afterAll`; everything else keeps the two-context rule. |

## Defaults JC can change (open questions in PLAN.md, answered by the orchestrator for now)
1. Rooms ring when <= 5 joined members, drop-in above that (`CALL_RING_MAX_MEMBERS`). 2. Ring-when-closed is out of this phase. 3. Anyone can start a call. 4. Voice channels before video. 5. Calls refused in unencrypted rooms. 6. Signal-bridged DM: icon hidden; bridged group: "Codec members only". 7. No per-person style yet: Discord-style rooms for everyone with the ring rule above.

## Advisor consultations (recorded)
PLAN.md carries the Advisor's rulings A1-B4 and C1-C8 (push is a hard dependency; no sticky events; well-known + unstable route; E2EE works in the Android WebView; Capawesome 7.0.1). Doubts raised while writing these tickets are in `matrix-poc/voice-calls/working/advisor-questions.md` under "PM"; the Advisor's Wave 19 rulings there are applied in these docs (keys reach unverified devices; Codec builds the ring with explicit mentions; exact js-sdk 43 event names; `joinRTCSession`; LiveKit 1.13.10 and lk-jwt-service 0.9.0 pins; third context kept for the three named tests).
