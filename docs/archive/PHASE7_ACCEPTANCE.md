# Phase 7 Acceptance Criteria and Test ID Contract

Extends docs/ACCEPTANCE.md and the Phase 2-6 acceptance docs (conventions, registries and criteria stay in force). Numbering `AC-R<group>-<n>`; each group names its tickets (docs/archive/PHASE7_TICKETS.md). **P0** = the desktop demo script in docs/archive/PHASE7_PLAN.md breaks without it, P1 = noticeably better, P2 = polish. "desktop" = the `desktop` Playwright project, "phone" = `mobile`, logged in as alice, **dirty seed always allowed**; "bob" = a second browser context logged in as bob (both verified via the Phase 5 helpers); "alice-2" = a second context logged in as alice (a second device). Automated runs use the **local Synapse + local LiveKit** (the per-instance call stack from `scripts/lib/rtc-stack.mjs`, started by `hs:up` / `hs:pool:up`) with Chromium's `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream` (already global in `playwright.config.ts`: a looping tone, permission auto-granted); `requireRtc(test)` skips a spec with `not-available` when LiveKit is not reachable. Test rooms: the alice/bob DM, `#vault` (encrypted, 3 members) and `#general` (unencrypted); never `seed:reset`. API names follow docs/archive/PHASE7_TICKETS.md "Shared API"; docs/ARCHITECTURE.md "Phase 7 deltas" wins on names, never on behaviour. Ringing in the automated suite is "the incoming card is shown"; real sound, real mics and the outside network are the manual checklist at the end.

## Wire shapes (Principal, Dev B and QA code against these)
**Call membership** is the js-sdk 43 `MatrixRTCSession` state: `org.matrix.msc3401.call.member` state events (application `m.call`, `call_id: ""` = the room's call, LiveKit identity `userId:deviceId` = `rtcBackendIdentity`, token from lk-jwt-service's `/sfu/get`), with a delayed leave event; the SDK sends these. **Ringing** is the MSC4075 event `org.matrix.msc4075.rtc.notification`, **built and parsed by Codec itself** (not the SDK's `sendCallNotify` / `parseCallNotificationContent`, which hardcode `@room` mentions and require an open rtc slot; Advisor Q5/F2): content `{ slot_id: "m.call#ROOM", notification_type: "ring", sender_ts, lifetime: 60000, "m.mentions": { user_ids: <exactly the rung members from ringPolicy> }, "m.relates_to": { rel_type: "m.reference", event_id: <own membership event id> } }`, sent right after the own membership event id is known. Media keys travel as `io.element.call.encryption_keys` to-device messages (any known device, verified or not). Declines use the SDK's `org.matrix.msc4310.rtc.decline` (see Chat lines). QA reads events via the API and builds by hand only the ring event (`ringAlice`), a decline (`declineAsBob`) and `dev.matrixpoc.call` (`sendCallLine`). "`m.rtc.member`" below means `org.matrix.msc3401.call.member`.

**Chat lines** (orchestrator ruling, 2026-10-18) come from three event types; history is shared through the room, so every device of every member sees the same lines (any localStorage call history is a local cache only, never a source):

| Line | Event | Sent by |
|---|---|---|
| `started` "X started a voice call" | the Codec-built ring `org.matrix.msc4075.rtc.notification`; for a drop-in call with no ring, the first `org.matrix.msc3401.call.member` membership that opens a session | the starter (SDK sends the membership) |
| `declined` "X declined" / "X declined (busy)" | `org.matrix.msc4310.rtc.decline` as js-sdk 43 ships it (`client.sendRtcDecline(roomId, notifyEventId)`; sticky on servers that support it, a plain event on 1.151), with the Codec field `io.codec.decline_reason: "busy"` added for the busy auto-decline | the callee who pressed Decline, or the store on busy |
| `ended` "Call ended, 12 min", `missed` "Missed call from X" | **one** Codec event `dev.matrixpoc.call`, sent encrypted like a message | `missed`: the caller when the 60 s ring ends with nobody joined **and nobody declined**; `ended`: the last participant to leave, best effort (a crashed last leaver leaves no line) |

```json
{ "kind": "ended" | "missed",
  "call_id": "<event id of the ring event, or of the first membership for a drop-in call>",
  "duration_ms": 312000,                                  // ended only
  "participants": ["@alice:localhost", "@bob:localhost"] } // ended: who was in the call; missed: the rung members who did not answer
```
Only rung calls send the ring event: a drop-in start (`ringPolicy` = `drop-in`) sends **no** `org.matrix.msc4075.rtc.notification`, its `started` line comes from the first membership. Row text on the sender's own device uses "You" ("You started a voice call", "You declined"); everyone else sees the display name. Reader: `getCallLine(event)` -> `{ kind, callId, durationMs?, participants?, reason?, sender }` or `null` for the three event types (unknown `kind`, non-array `participants`, negative `duration_ms`, a ring with `notification_type` other than `ring`/`notification`, a membership that joins an already open session -> `null`, rendered as nothing). `previewText`: `Missed call` when `kind` is `missed` and I am in `participants`, else `Call ended` / `Call declined` / `Voice call`. None of these events is ever a thread root or reply.

## Test ID registry (additions)
### Call feature (Dev B, `src/features/call/**`)
| testid | Element |
|---|---|
| `header-call` (+`data-mode="ring\|drop-in"`, `data-disabled-reason="unencrypted\|busy"` when disabled) | The phone button (`aria-label="Start a call"`; `title` "Calls need an encrypted room" when `unencrypted`); **not rendered** when `canCall(roomId).reason === 'bridged-dm'` |
| `header-call-hint` | "Codec members only" next to the button in a bridged group |
| `incoming-call` (+`data-room-id`, `data-from`) | Full-screen card; `role="dialog"`, `aria-label="Incoming call"`; contains `incoming-call-name`, `incoming-call-room`, `incoming-call-accept`, `incoming-call-decline` (>= 44 px on phone) |
| `incoming-call-muted` | Note on the card when the ringtone cannot play (no prior gesture): "Click anywhere to hear the ringtone" |
| `call-screen` (+`data-state="calling\|connecting\|connected\|reconnecting\|no-answer\|busy\|ended"`) | The in-call screen (phone: full screen; desktop: panel over the member column), `role="dialog"`, `aria-label="Voice call"` |
| `call-lock` | Lock icon, `title="End-to-end encrypted (the call server only sees scrambled audio)"` |
| `call-timer` | `mm:ss` since `connected` |
| `call-participant-{userId}` (+`data-speaking`, `data-muted`, `data-poor`, `data-keys="ok\|missing"`) | One avatar tile per participant, self included |
| `call-participant-nokeys` | "No call keys from X yet" note for a tile with `data-keys="missing"` |
| `call-mute`, `call-speaker`, `call-leave`, `call-minimise` | Controls (`aria-pressed` on mute and speaker; `call-speaker` phone only; `call-leave` red; all >= 44 px on phone) |
| `call-status` | "Calling...", "No answer", "Busy", "Reconnecting..." text |
| `call-back` | Button on a missed-call line (and on the `no-answer` screen): starts a call in that room |
| `call-close` | Close button on the `no-answer` / `ended` screen: dismisses `call-screen` without starting anything |
| `in-call-bar` (+`data-room-id`) | Slim bar "In call <mm:ss>, tap to return" shown while `activeCall` exists and `call-screen` is minimised; click reopens the screen; contains `in-call-bar-leave` |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `message-call` (+`data-kind="started\|ended\|declined\|missed"`, `data-missed="true"` when the viewer is in a `missed` event's `participants`) | Grey system-style row for any event `getCallLine` accepts (ring, decline, first membership, `dev.matrixpoc.call`); text per AC-R7; no avatar, no actions toolbar, no reactions; `message-call[data-missed="true"]` contains `call-back` |

### Navigation (Dev A, `src/features/navigation/**`)
| testid | Element |
|---|---|
| `header-join-call` (+`data-count`) | Green chip "Join voice (n)" in the header while a call is live in the room and I am not in it; click joins; hidden otherwise |
| `room-call-indicator` (+`data-count`) | Speaker icon + count on a channel or DM row while a call is live there |
| `channel-item-*` / `dm-item-*` with `data-preview="missed-call"` | Row whose last-message preview is a missed call for me: red-tinted preview text "Missed call" |

### Shell and core (Principal)
| testid | Element |
|---|---|
| `call-host` | Shell mount for `IncomingCallCard`, `CallScreen`, `InCallBar` (desktop and phone; one instance) |
| `app-shell[data-in-call="true"]` | While `activeCall` exists |
| `window.__matrixPoc.call` | `useCallStore` + `canCall`, `ringPolicy`, `getCallLine`, `CALL_RING_MAX_MEMBERS`, `rtc` (the `src/lib/rtc` module), `ringtone` (`{ canPlay(), lastPlayedAt }`) |

## Criteria

### AC-R1 Local RTC dev stack (PRIN-27)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R1-1 | P0 | `npm run hs:up` (which chains `rtc:up`) starts Synapse plus the local call stack from `scripts/lib/rtc-stack.mjs`: the pinned `livekit-server` **1.13.10** binary (the homelab installs the same version; fetched once into `homeserver/.rtc`, loopback only; ws `localhost:7880`, media TCP `7920`, UDP `7940`) and the Node jwt service `scripts/lib/lk-jwt.mjs` (`http://localhost:7980`, verifying against that Synapse); `GET http://localhost:7980/healthz` is 200 and `OPTIONS /sfu/get` answers `Access-Control-Allow-Origin: *`; `POST /sfu/get` with alice's OpenID token returns `{ url: "ws://localhost:7880", jwt }` whose claims carry `video.room` = `livekitRoomAliasFor(roomId)` and identity `@alice:localhost:<deviceId>`; `GET http://localhost:8008/.well-known/matrix/client` has `org.matrix.msc4143.rtc_foci[0] = { type: "livekit", livekit_service_url: "http://localhost:7980" }` with `Access-Control-Allow-Origin: *`; `npm run rtc:status` reports both. |
| AC-R1-2 | P0 | The local `homeserver.yaml` has `experimental_features` `msc3266_enabled`, `msc4140_enabled`, `msc4222_enabled`, `msc4143_enabled`, `msc4075_enabled` true, `max_event_delay_duration: 24h`, and `rc_delayed_event_mgmt` raised; `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports` with alice's token is 200 or 404 (both accepted; the client falls back to well-known). `e2e/homeserver-config.spec.ts` checks it. |
| AC-R1-3 | P0 | `npm run rtc:probe` (alice + bob from `seed-output.json`, Node) fetches a LiveKit token through the jwt service for each, decodes it (`decodeJwtClaims`) and exits 0 printing `{ url, identity, room }`; exits 1 with a one-line reason when LiveKit or the jwt service is down. `requireRtc(test)` uses the same probe. |
| AC-R1-4 | P1 | `npm run hs:pool:up` starts one call stack per pool Synapse (ports `7880+i` / `7980+i`, each instance's well-known pointing at its own jwt service) and `hs:pool:down` stops them; `E2E_NO_RTC=1` skips the stacks and the call specs skip with `not-available`; a missing or undownloadable binary is a one-line error naming `LIVEKIT_SERVER_BIN`, Synapse still starts. |

### AC-R2 Call core (PRIN-28, PRIN-29)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R2-1 | P0 | `matrix-js-sdk` stays `43.x`, `livekit-client` is `2.23.x` and the E2EE worker is bundled by Vite (`new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' })` loads in the dev build and the APK origin); `npm run typecheck` and `build` pass; `test:e2e:e2ee` and `test:e2e:threads` are green with the new dependency (gate before anything else in Wave 19). `MatrixRTCSession` uses **state-event** memberships (`m.call.member`, no sticky events) and `/sfu/get`, stated in ARCHITECTURE "Phase 7 deltas" together with the deferred 44 bump. Node unit tests for `livekit-token.ts` (`npm run test:unit`): `livekitRoomAliasFor`, `legacyLivekitIdentity`, `mintLivekitToken` round-trip through `decodeJwtClaims`. |
| AC-R2-2 | P0 | Given alice calls `__matrixPoc.call.startCall(dmRoomId, { ring: true })`, then within 5 s an `org.matrix.msc3401.call.member` state event for alice's device exists in the room (API), one `org.matrix.msc4075.rtc.notification` with `notification_type: "ring"`, `lifetime: 60000`, `m.mentions.user_ids` = `["@bob:localhost"]` (no `room: true`) and `m.relates_to.event_id` = that membership event was sent by alice, a `POST /sfu/get` was made with alice's OpenID token and `device_id`, and `activeCall.state` is `calling`. |
| AC-R2-3 | P0 | Given bob then calls `join(dmRoomId)` in his context, then within 10 s both stores show `state: 'connected'` and two `participants`; each participant's `keyState` becomes `ok` (media keys exchanged over the Phase 5 crypto); the LiveKit room (via `rtc` dev hook) reports `isE2EEEnabled === true` and one remote audio track attached per peer. |
| AC-R2-4 | P0 | Given `leave()`, then alice's `m.rtc.member` is cleared within 5 s, the mic track is stopped (`MediaStreamTrack.readyState === 'ended'`) and `activeCall` is `null`; given the page is closed instead, the server's delayed leave clears the membership within the `lifetime` (<= 30 s) and bob's store drops the participant. |
| AC-R2-5 | P1 | Given the LiveKit websocket is dropped (QA: `page.route` / `context.setOffline(true)` for 5 s), then `state` goes `reconnecting` and back to `connected` within 20 s; participants are unchanged. |
| AC-R2-6 | P1 | Given a room without `m.room.encryption`, then `startCall` rejects with `CallRefusedError('unencrypted')` and sends nothing; given bob's context blocks its outgoing media keys (QA: `page.route` aborting `PUT /_matrix/client/v3/sendToDevice/m.room.encrypted/*` in bob's context before he joins), then on alice's side bob's `keyState` is `missing` after `CALL_KEYS_TIMEOUT_MS` (5 s) and never `ok` while the block holds; unblocking and a re-join by bob brings it to `ok`. An unverified-but-known device is **not** a `missing` case (Advisor Q2): bob's second, unverified device joining gets `ok` within 5 s. |

### AC-R3 Store, ring policy, lines (PRIN-30, PRIN-33)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R3-1 | P0 | `canCall(roomId)` returns `{ allowed: true }` for the DM and `#vault`; `{ allowed: false, reason: 'unencrypted' }` for `#general`; `{ allowed: false, reason: 'busy' }` for any room while `activeCall` exists in another room; `{ allowed: false, reason: 'bridged-dm' }` for a DM whose only other member matches `@signal_*` or where `m.bridge` names the only other member (P1, QA sets the state via API); `{ allowed: true, hint: 'codec-only' }` for a group with a bridge ghost (P1). |
| AC-R3-2 | P0 | `ringPolicy(roomId)` is `ring` for DMs and for rooms with <= `CALL_RING_MAX_MEMBERS` (5) joined members excluding self and ghosts, `drop-in` above that (QA: a 7-member room created via API). `startCall` sends one `org.matrix.msc4075.rtc.notification` (`notification_type: "ring"`) for `ring` and **no** notification event at all for `drop-in` (the session's first membership is the only trace; orchestrator ruling). |
| AC-R3-3 | P0 | Given bob sends the ring event (`ring`, `m.mentions.user_ids` containing alice) in the DM, then alice's `incoming[0]` is `{ roomId, from: bob, notifyEventId, receivedAt }` within 3 s; it is removed when alice accepts, declines, when the sender's membership disappears (caller hung up), or at `sender_ts + lifetime` (capped at 60 s); a notification already expired on arrival (QA: `sender_ts` 2 min old), one from self, one with `notification_type: "notification"`, or one whose `user_ids` does not contain alice is ignored (no card). Codec's own parser is used, not the SDK's (no rtc slot or `@room` power-level requirement). |
| AC-R3-4 | P0 | Given alice and alice-2 both have `incoming` for the same call, when alice-2 accepts, then alice's `incoming` empties within 3 s (own user's membership appeared) and no `declined` line is sent; the same when alice-2 declines. |
| AC-R3-5 | P0 | Given `activeCall` exists and a ring arrives for another room, then the store auto-sends `org.matrix.msc4310.rtc.decline` for that ring with `io.codec.decline_reason: "busy"` within 2 s and the card is **not** shown; the caller's `state` becomes `busy`. |
| AC-R3-6 | P0 | Given alice starts a DM call and nobody joins for 60 s, then `state` is `no-answer`, alice's membership is cleared, and exactly one `dev.matrixpoc.call` `missed` with `participants: [bob]` and the ring's event id as `call_id` was sent; given bob declined at 20 s instead, no `missed` is sent. Given a 1:1 call where bob leaves after 70 s, then alice's call ends too (`state: 'ended'`, then `activeCall` null) and the last to leave (alice, whose client leaves on bob's departure) sends `ended` with `duration_ms` within +/- 2 s of the connected time and `participants` = both. Given a 3-person room call, the first two leavers send nothing; the last leaver sends `ended` (best effort: a closed tab leaves no line). |
| AC-R3-7 | P0 | `getCallLine` returns `started` for a ring event and for the first membership state event of a session (`null` for memberships joining an open session), `declined` (+`reason: 'busy'` from `io.codec.decline_reason`) for `org.matrix.msc4310.rtc.decline`, `ended` / `missed` for `dev.matrixpoc.call`, and `null` for `kind: "x"`, a non-array `participants` or a negative `duration_ms`; `previewText` is `Missed call` for a `missed` event listing me, `Voice call` for `started`, `Call ended` for `ended`, `Call declined` for `declined`; `unreadByRoom` counts a `missed` event like a message. `isDisplayableEvent` keeps all of them in the main timeline only (never thread roots); alice-2 shows the same rows as alice (room history, not local state). |
| AC-R3-8 | P0 | Given the ringtone helper, then `ringtone.canPlay()` is false before any user gesture on the page and true after one click; `play()` before a gesture resolves without throwing and sets `lastPlayedAt` null. |

### AC-R4 Starting a call (DEV-B-35, DEV-A-33)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R4-1 | P0 | Given the alice/bob DM, then the header has `header-call[data-mode="ring"]` and no `header-join-call`; clicking it opens `call-screen[data-state="calling"]` with `call-status` "Calling...", `call-lock`, `call-participant-@alice:localhost`, `call-mute`, `call-leave`; bob's context shows `incoming-call[data-from="@alice:localhost"]` within 3 s. |
| AC-R4-2 | P0 | Given `#general` (unencrypted), then `header-call` is disabled with `data-disabled-reason="unencrypted"` and the title "Calls need an encrypted room"; clicking does nothing. |
| AC-R4-3 | P0 | Given `#vault` (3 members), `header-call` has `data-mode="ring"`; given a 7-member encrypted room (API), `data-mode="drop-in"` and clicking it opens `call-screen[data-state="connecting"]` then `connected` with one participant, and bob's context shows **no** `incoming-call` but `header-join-call[data-count="1"]` when he opens that room. |
| AC-R4-4 | P0 | Given alice in a call, then `header-call` in every other room has `data-disabled-reason="busy"`. |
| AC-R4-5 | P0 | Given `getUserMedia` rejects (QA: `page.context().grantPermissions([])` + override via `page.addInitScript` to throw `NotAllowedError`), when alice clicks `header-call`, then `toast` reads "Codec can't use your microphone. Allow it in the browser's site settings and try again", no `m.rtc.member` or ring event is sent, and `call-screen` is not shown. |
| AC-R4-6 | P1 | Given a DM whose other member is `@signal_123:localhost` (API-created, `m.bridge` state), then `header-call` is **not** in the DOM; given a group with such a ghost, `header-call` is present and `header-call-hint` reads "Codec members only". |

### AC-R5 Incoming call (DEV-B-36)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R5-1 | P0 | Given a ring from bob, then `incoming-call` shows `incoming-call-name` "bob" (display name), `incoming-call-room` the DM name (or room name for a room ring), Accept and Decline; the document title alternates with "Incoming call from bob" every second while shown; before any gesture `incoming-call-muted` is shown, after one click it is gone and `ringtone.lastPlayedAt` is set. |
| AC-R5-2 | P0 | When alice clicks `incoming-call-accept`, then the card closes, `call-screen` opens and reaches `connected` within 10 s (both sides), and no `declined` line is sent. |
| AC-R5-3 | P0 | When alice clicks `incoming-call-decline`, then the card closes, an `org.matrix.msc4310.rtc.decline` for bob's ring is sent (no `io.codec.decline_reason`), bob's `call-screen` goes to `data-state="ended"` with `call-status` "alice declined" and closes after 3 s; bob's timeline shows `message-call[data-kind="declined"]` "alice declined" and alice's own shows "You declined". |
| AC-R5-4 | P0 | Given the card is ignored for 60 s, then it closes by itself, bob's side sends `missed`, and alice's timeline shows `message-call[data-kind="missed"][data-missed="true"]` "Missed call from bob" with `call-back`. Given the caller hangs up at 20 s, the card closes within 3 s and the same missed line appears. |
| AC-R5-5 | P0 | Given alice and alice-2 both show the card, when alice-2 accepts, then alice's card closes within 3 s and alice's title stops flashing; the ringtone (if playing) stops. |
| AC-R5-6 | P1 | Given phone, then `incoming-call` covers the viewport, Accept / Decline are >= 56 px and at the bottom above the safe area, `navigator.vibrate` was called with a repeating pattern (QA stubs it), and Android back declines (`registerBackHandler`, manual on device). |

### AC-R6 In the call (DEV-B-37)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R6-1 | P0 | Given a connected DM call, then `call-screen[data-state="connected"]` shows one `call-participant-*` per participant (2), `call-timer` advancing from `00:00`, `call-lock`, and the desktop panel sits over the member column (its left edge >= the conversation's right edge - 1 px); the conversation stays interactive. |
| AC-R6-2 | P0 | When alice clicks `call-mute`, then `aria-pressed="true"`, her local track is muted (`__matrixPoc.call.rtc` reports `isMicrophoneEnabled === false`), and within 3 s bob's `call-participant-@alice:localhost` has `data-muted="true"`; clicking again clears both. |
| AC-R6-3 | P1 | Given the fake mic tone on bob's side and alice muted, then alice's `call-participant-@bob:localhost` gets `data-speaking="true"` within 5 s of connecting and alice's own tile does not. |
| AC-R6-4 | P0 | When alice clicks `call-minimise` (or the backdrop on desktop), then `call-screen` is hidden, `in-call-bar` shows "In call 00:xx, tap to return" above the composer (phone: at the top of `main`), the composer sends a message normally, and clicking the bar reopens `call-screen` with the same timer; `in-call-bar-leave` leaves. |
| AC-R6-5 | P0 | When alice clicks `call-leave`, then her screen closes within 1 s, bob's screen shows `data-state="ended"` for up to 2 s then closes (1:1 ends for both), `app-shell[data-in-call]` is `false` on both, and the timeline shows `message-call[data-kind="ended"]` "Call ended, 1 min" (`< 1 min` for under a minute). |
| AC-R6-6 | P0 | Given a `#vault` call with alice, bob and carol (carol = a third browser context, serial, closed in the same test; Advisor Q4), when bob leaves, then alice's screen stays `connected` with 2 tiles and no `ended` line; when alice leaves too, carol (last) sends `ended`. |
| AC-R6-7 | P1 | Given `data-state="reconnecting"`, `call-status` reads "Reconnecting..." and the controls stay enabled; given a participant with `keyState: 'missing'` (AC-R2-6 setup), their tile has `data-keys="missing"` and `call-participant-nokeys` "No call keys from bob yet"; it clears when `keyState` becomes `ok`. |
| AC-R6-8 | P1 | Given `no-answer`, `call-status` "No answer" with `call-back` and `call-close` (click closes the screen, `activeCall` null, nothing sent); given `busy`, "Busy" and the screen closes after 3 s. |

### AC-R7 Timeline lines and missed-call preview (DEV-B-38, DEV-A-34, PRIN-30)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R7-1 | P0 | Given a ring event sent via API by bob (`ringAlice`), then the row is `message-call[data-kind="started"]` reading "bob started a voice call" (orchestrator ruling: the text is "started a voice call", BUG-36; on the **sender's own device** every call line says "You": "You started a voice call", "You declined", while other users' devices show the display name), grey, no avatar, no `message-actions`, no reaction row, not groupable with messages; a drop-in call bob joins first (membership only, no ring) shows the same `started` row once, and his later re-join of an open session shows nothing; a `dev.matrixpoc.call` `ended` via API reads "Call ended, 12 min" (`duration_ms` rounded to minutes, "< 1 min" under 60 s); an `org.matrix.msc4310.rtc.decline` via API reads "bob declined" ("bob declined (busy)" with `io.codec.decline_reason: "busy"`). |
| AC-R7-2 | P0 | Given `dev.matrixpoc.call` `missed` from bob with `participants` containing alice, then alice sees `message-call[data-kind="missed"][data-missed="true"]` "Missed call from bob" in red with `call-back`; clicking `call-back` starts a call in that room (AC-R4-1 state); bob sees the same event as "No answer from alice" without the red tint or button. |
| AC-R7-3 | P0 | Given that missed event is the room's last event, then the DM row in `DmList` (and a channel row in `ChannelList`) has `data-preview="missed-call"` with preview text "Missed call" and the usual unread badge; opening the room clears the badge as for any message. |
| AC-R7-4 | P1 | Given a malformed `dev.matrixpoc.call` (unknown `kind`) or a decline event with no `m.relates_to`, then no row is rendered and nothing throws; a redacted one renders `message-redacted`. Call lines never appear in `thread-message-list` or the Threads list. |

### AC-R8 Header chip and sidebar indicators (DEV-A-33, DEV-A-34)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R8-1 | P0 | Given bob is in a `#vault` call and alice is not, then alice's header shows `header-join-call[data-count="1"]` "Join voice (1)" (green) and `header-call` is hidden; clicking the chip joins (`call-screen` connecting then connected, `data-count` becomes 2 for a third user); when alice is in that call the chip is hidden and `in-call-bar` carries the state. |
| AC-R8-2 | P0 | Given the same, then `#vault`'s row in `ChannelList` has `room-call-indicator[data-count="1"]`; the DM row shows it for a DM call; the indicator disappears within 5 s of the last leave. |
| AC-R8-3 | P0 | Given phone, then `header-join-call` fits in the header on a 393 px viewport (no overflow, name truncates) and is >= 44 px tall; `room-call-indicator` is visible in the nav drawer. |
| AC-R8-4 | P2 | Hovering `header-join-call` lists the participants' display names (`title`); `room-call-indicator` has `aria-label="n in voice"`. |

### AC-R9 Phone and Android (DEV-B-39, PRIN-31)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R9-1 | P0 | Given phone, `call-screen` fills the viewport (`app-shell` bounds, safe areas respected), `call-mute` / `call-speaker` / `call-leave` are >= 56 px in a bottom bar; `call-speaker` toggles `aria-pressed` and calls the speakerphone shim (QA stubs `__matrixPoc.call.rtc.setSpeakerphone`); the composer keyboard never covers `in-call-bar`. |
| AC-R9-2 | P0 | Android back while `call-screen` is open minimises it (bar stays, call continues); back on `incoming-call` declines (`registerBackHandler` order: call > GIF sheet > thread > drawers). **Manual, device.** |
| AC-R9-3 | P0 | `AndroidManifest.xml` declares `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, `BLUETOOTH_CONNECT` and the Capawesome service with `android:foregroundServiceType="microphone"`; `@capawesome-team/capacitor-android-foreground-service` is pinned `7.0.x`; `npm run test:android-build` passes. |
| AC-R9-4 | P0 | On a real Android phone: Accept/Join starts the foreground service (persistent "Codec call" notification with a Hang up action) before `room.connect`; locking the screen for 2 minutes keeps the call connected and audible both ways; Leave (or the notification's Hang up) stops the service and the notification within 2 s; starting a call never requests the service from the background. **Manual, device** (PRIN-31 report + the checklist below). |
| AC-R9-5 | P1 | `POST_NOTIFICATIONS` is requested on the first Accept/Join on Android 13+; denying it still lets the call run (service without a visible notification is not possible: fall back to a toast "Calls may drop when the screen locks"). **Manual, device.** |

### AC-R10 Suites, regression, docs (QA-34..38, PRIN-32)
| ID | P | Given / When / Then |
|---|---|---|
| AC-R10-1 | P0 | `e2e/calls-core.spec.ts` (the Principal's core spec: AC-R2-2..6, AC-R3-1..3/8 through `__matrixPoc.call`, handed to QA in Wave 20), `e2e/call-dm.spec.ts` (AC-R3-4..6, R4-1/2/4/5, R5, R6-1/2/4/5, R7), `e2e/call-room.spec.ts` (AC-R3-1/2 UI, R4-3, R6-6, R8) and `e2e/mobile-call.spec.ts` (AC-R5-6, R6-4 phone, R8-3, R9-1) run serial with `requireRtc`; at most two contexts, except the multi-device tests (AC-R3-4, AC-R5-5) and the 3-person room test, which open a third context and close it in the same test; `npm run test:e2e:calls` runs the desktop three, `mobile-call.spec.ts` joins the `mobile` project. |
| AC-R10-2 | P0 | Every context opened for a call test is closed in `afterAll`, leaving no `m.rtc.member` behind (the fixture's `cleanupCalls()` clears alice's, bob's and alice-2's `org.matrix.msc3401.call.member` state via the SDK before and after each spec), so a crashed run cannot make the next one start inside a stale call. |
| AC-R10-3 | P0 | `e2e/smoke.spec.ts` step 14 walks desktop demo steps 1-7 (bob = second context) with a screenshot per sub-step in `e2e/results/demo/14-*`; `e2e/mobile-smoke.spec.ts` step 14 covers phone AC-R9-1 with the DM call. |
| AC-R10-4 | P0 | `desktop` and `mobile` projects plus `test:e2e:e2ee` and `test:e2e:threads` are green after `livekit-client` and the worker bundling land (AC-R2-1 gate) and at the end of Wave 20 (known fresh-seed skips only); recorded in docs/STATUS.md. |
| AC-R10-5 | P0 | docs/BUGS.md "Phase 7" carries the manual 704.chat checklist below with a result column per tester; docs/ARCHITECTURE.md has "Phase 7 deltas" (module map, js-sdk 43 kept + the deferred 44 bump, `MatrixRTCSession` mode and `/sfu/get`, the Node jwt port and why (federation discovery cannot reach a plain-HTTP localhost Synapse), the exact event type names, Codec-built ring with explicit mentions, focus discovery order, key transport (`io.element.call.encryption_keys`, no trust check, the `missing` cases), the `dev.matrixpoc.call` contract, the three-context exception, the LiveKit 1.13.10 / lk-jwt-service 0.9.0 pins); docs/MOBILE.md documents the foreground service, permissions and the lock-screen test. |
| AC-R10-6 | P1 | Every bug fixed in Wave 21 has a regression test in `e2e/` (JC's rule). |

## Manual 704.chat checklist (real audio, real mics, outside network, two devices)
Run by JC, Charlie and Juanjo after Wave 20, on 704.chat with the homelab LiveKit (product Phase 0 done). Web = Chrome on a laptop; Phone = the Phase 7 APK. Record results in docs/BUGS.md "Phase 7". Pass = all P0 rows green.

| # | P | Steps | Pass when |
|---|---|---|---|
| M1 | P0 | JC (web, LAN) calls Charlie from their DM; Charlie's phone (app open) rings | Ring within 3 s, JC's name on the card, ringtone + vibration |
| M2 | P0 | Charlie accepts; talk for 5 minutes | Both hear each other clearly, no drop, no echo with the earpiece; timer agrees on both sides within 2 s |
| M3 | P0 | Either side leaves | Both screens close; "Call ended, 5 min" in the DM on both devices |
| M4 | P0 | Juanjo, **outside** the home network on mobile data, calls JC and is called by JC | Same quality as M2; connects within 5 s; works again on Wi-Fi away from home |
| M5 | P0 | All three in `#lobby` (encrypted, 3 members): JC starts (everyone rung), Charlie accepts, Juanjo joins by the chip; speak in turn; one mutes; one leaves | Speaker outline follows the talker on all devices; crossed mic shows on the muted person; the call continues for the two left; header chip shows the count to the one who left |
| M6 | P0 | Decline a call; let another ring out for 60 s | "X declined" line; "Missed call from X" in red with Call back on the callee, "Missed call" preview + badge in the sidebar; Call back starts a call |
| M7 | P0 | JC has Codec open in Chrome **and** on the phone; Charlie calls; JC answers on the phone | Both ring; the browser stops ringing and its card closes when the phone answers |
| M8 | P0 | On the phone, in a call: lock the screen for 2 minutes, then switch to another app for 2 minutes | Audio keeps flowing both ways; "Codec call" notification visible; Hang up from the notification ends the call |
| M9 | P0 | Deny the mic permission (Chrome site settings / Android app settings), then tap the phone icon | A clear message with how to allow; no call screen, no line in the chat, the other side is not rung |
| M10 | P0 | Open the call screen | Lock icon present. JC on the server: LiveKit logs / `livekit-cli` show E2EE frames (no decodable audio), and `tcpdump` on the tunnel host shows no RTP (media bypasses Cloudflare) |
| M11 | P0 | Open `#general` or any unencrypted room | Phone icon disabled with "Calls need an encrypted room" |
| M12 | P1 | Call someone whose phone's Codec is **closed** | No ring (expected in this phase); "Missed call" shows when they next open Codec |
| M13 | P1 | Walk out of Wi-Fi range mid-call on the phone (handover to mobile data) | "Reconnecting..." then audio resumes within 20 s, or a clean end with "Call ended" |
| M14 | P1 | Firefox and Safari on a laptop: receive and make one call each | Audio both ways (ScriptTransform E2EE path, Advisor C8) |
| M15 | P1 | Someone joins from a **new, unverified** device | Audio both ways within 5 s: verification is not a call prerequisite (Advisor Q2). If a tile ever shows "No call keys from X yet", note the device and whether a re-join clears it |
