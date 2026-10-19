# Voice notes that play for everyone (format plan)

Problem (JC): a note recorded on Chrome/Android is sent as WebM/Opus, and iPhones older than iOS 18.4 can't play
WebM. Every voice note must play for every listener. Branch `claude/voice-notes-format-*`. Criteria: AC-F below;
tests go in `e2e/voice.spec.ts` style (testids `voice-message`, `voice-play`, `data-state`, `data-mimetype`).

## What the user sees

| | Before | After |
|---|---|---|
| Send from Chrome / Android | Note arrives as `audio/webm`, `Voice message.webm` | Note arrives as `audio/ogg`, `Voice message.ogg`, same length and waveform, same send flow and timing |
| Send from Firefox | `audio/ogg` | Unchanged |
| Send from Safari / iOS | `audio/mp4` (AAC) | Unchanged (plays natively everywhere) |
| Listen on Chrome, Android, Firefox, new Safari | Plays | Plays exactly as before (native `<audio>`, no extra download) |
| Listen on an iPhone older than 18.4 | New notes from Chrome/Android: `voice-error` + download link | New Ogg notes **and** old WebM notes play, with scrubber, seek and duration; first play may show `loading` briefly |
| Note that is really undecodable (corrupt, 404) | `voice-error` + download link | Same |
| Remux fails on send | n/a | The original recording is sent with its own mimetype; the user never sees an error caused by the remux |

## How (decisions already made, see the team brief)
1. **Send**: WebM/Opus from MediaRecorder is losslessly remuxed to Ogg/Opus in pure TS (`src/lib/audio/ogg.ts`
   behind the existing `encodeToOggOpus` seam). Ogg and MP4 recordings pass through. Any remux error falls back to
   the original blob. Duration and waveform are still computed from the original recording.
2. **Play**: `VoiceMessage` tries the native `<audio>` path first. Only if `canPlayType` says `''` for the note's
   container, or the element errors / `play()` rejects with a format error, it lazy-loads `ogg-opus-decoder`,
   decodes to PCM, wraps it as a 16-bit WAV blob and plays that through the same `<audio>` + blob: URL. Old WebM
   notes are remuxed to Ogg in the browser first. Browsers that play natively never load the decoder.
3. Event shape (MSC1767/MSC3245), authenticated media fetch, `uploadMedia`, one-note-at-a-time: unchanged.

Observability for QA (new, small): `voice-message` gets `data-playback="native" | "fallback"` once playback has
started, and dev builds expose `window.__matrixPoc.voice.forceRemuxFailure = true` to make the remux throw.
Simulating an old iPhone in Chromium = `page.addInitScript` that makes `HTMLMediaElement.prototype.canPlayType`
return `''` for `audio/ogg*` and `audio/webm*` (Chromium then still decodes the WAV natively, as iOS would).

## Acceptance criteria

| ID | Given / When / Then |
|---|---|
| AC-F1 | Given Chromium (mobile project), when alice records ~3 s and taps `recording-send`, then the event passes AC-V2-1/2 unchanged except: `info.mimetype` = `audio/ogg`, `org.matrix.msc1767.file.mimetype` = `audio/ogg`, `org.matrix.msc1767.file.name` = `Voice message.ogg`. |
| AC-F2 | Given that event, when the media is downloaded, then byte length = `info.size`, the first 4 bytes are `OggS`, and the response content type contains `audio/ogg`. This replaces the AC-V2-4 waiver (now met). |
| AC-F3 | Given that event, then `info.duration` is within +-700 ms of the held time, `org.matrix.msc1767.audio.duration` equals it, and the waveform satisfies AC-V2-2 (computed from the original recording). |
| AC-F4 | Given alice's own Ogg note in Chromium, then AC-V3-1..V3-6 pass as before (play, pause, resume, end, seek to half, one at a time) and `voice-message` shows `data-mimetype="audio/ogg"` and `data-playback="native"`; no request for an `ogg-opus-decoder` chunk is made. |
| AC-F5 | Given the simulated old iPhone (canPlayType `''` for ogg/webm) and a new Ogg note, when I tap `voice-play`, then `data-state` goes `loading` (allowed) -> `playing` within 5 s, `data-playback="fallback"`, `voice-duration` shows the total before play and elapsed while playing, and `data-position-ms` increases across two polls. |
| AC-F6 | Given the same simulated browser and an **old WebM note** (bob posts `e2e/fixtures/chromium-3s.webm` via the API as `audio/webm`), when I tap `voice-play`, then it plays as in AC-F5 with `data-mimetype="audio/webm"` and `data-playback="fallback"`. |
| AC-F7 | Given a fallback-decoded note (AC-F5 or AC-F6) playing, when I set `voice-progress` to half the duration, then `data-position-ms` is within 300 ms of it and playback continues; pause/resume and end-to-`idle` behave as AC-V3-3/4. |
| AC-F8 | Given a browser that plays natively (plain Chromium), when alice's Ogg note and bob's WebM note are played, then both show `data-playback="native"` and the `ogg-opus-decoder` chunk is never requested (assert on network requests across the whole test). |
| AC-F9 | Given `window.__matrixPoc.voice.forceRemuxFailure = true` in a dev build, when alice records ~3 s and sends, then the send succeeds (no `recording-error`), `info.mimetype` = `audio/webm`, file name `Voice message.webm`, bytes start `1A 45 DF A3`, and the note plays. |
| AC-F10 | Given a blob of type `audio/ogg` or `audio/mp4` passed to `encodeToOggOpus` (via `window.__matrixPoc`, bytes need not be real), then the returned blob is the same object/bytes and `mimetype` is the input's base type: Firefox and Safari recordings are sent unchanged. |
| AC-F11 | Given a note whose bytes cannot be decoded (bob posts random bytes as `audio/ogg`) in the simulated old iPhone, when I tap `voice-play`, then `voice-error` appears with the "can't play" text and a download `a[href]`, `data-state="error"`, and there is no uncaught page error. AC-V5-4 (404) still passes. |
| AC-F12 | Given the above, then `npm run typecheck` is clean and the existing voice suite (AC-V1..V6, AC-V2-5 cross-client) stays green; the `AC-V2-4 (waived)` annotation in `e2e/voice.spec.ts` is replaced by a real assertion. |

| AC-F13 | **Manual** (Playwright has no WebKit here): on a real iPhone running iOS < 18.4 (Safari or the Capacitor app), a new Ogg note from Chrome/Android and an old WebM note both play on the first tap, seek works, duration is right, and a note from the same phone (MP4/AAC) plays on Chrome desktop and in Element. Record device + iOS version in docs/STATUS.md. |

Priority: AC-F1, F2, F5, F6, F9, F11 are P0; F3, F4, F7, F8, F10, F12 are P1 but expected in the same change; F13 before sign-off.
