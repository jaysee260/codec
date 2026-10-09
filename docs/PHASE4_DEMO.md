# Matrix POC GIF picker - Demo Handoff (Phase 4)

The Phase 1-3 client (docs/DEMO.md, docs/PHASE2_DEMO.md, docs/PHASE3_DEMO.md), now with a Slack-style GIF picker: `/gif <query>`, `/giphy <query>`, or the **GIF** button beside the paperclip, on desktop and phone. GIFs come from Klipy (Tenor shut down in June 2026; Giphy's API is paid). Final test numbers: docs/STATUS.md "Phase 4".

## 1. The one decision to know about
Klipy's integration terms forbid storing, mirroring, re-hosting or proxying its media, so picked GIFs are **hot-linked**: the message is an `m.text` whose body is `<title> <url>` plus a `dev.matrixpoc.gif` field this client renders inline (animated, `GIF` badge, paused off screen, click-to-play under reduced motion). Element and other clients show the title and the link, and should unfurl it now that URL previews are enabled on the homeserver (not yet verified from here). Nothing is uploaded to Synapse. Details: docs/ARCHITECTURE.md "Phase 4 deltas".

## 2. Keyless vs with a Klipy key
| | `mock` (no key, what is built now) | `klipy` (after step 3 below) |
|---|---|---|
| Source | 8 generated fixture GIFs served by the app itself | Klipy search and trending |
| Works offline / on the LAN only | yes | no, the device needs internet for `static.klipy.com` |
| Cross-device | **no**: the GIF URL is the sender's own origin, so a mock GIF sent from the desktop shows as a text line on the phone and the other way round (documented limitation, not a bug) | yes |
| Picker copy | `Search GIFs`, `Mock GIFs (no key)` | `Search KLIPY`, `Powered by KLIPY` (Klipy's required attribution) |

## 3. Your steps (user-only)
1. Create a free key at https://partner.klipy.com/api-keys ("Add Platform"; a Test key allows 100 requests per hour, Production is unlimited via the form there).
2. Put it in `.env` as `VITE_GIF_API_KEY=...` (see `.env.example`) and restart `npm run dev`. Without a rebuild you can also run `localStorage.setItem('matrix-poc.gifApiKey', '...')` in DevTools and reload.
3. Rebuild and reinstall the APK with the key baked in: `npm run cap:build:android:lan`. The key is extractable from the APK; use a Test key you can revoke.
4. `npm run seed:reset` before a demo: the QA runs left test rows in `#dev` (some show Klipy's "content no longer available" placeholder because the tests stub the CDN).
5. Manual checks nobody here could do (listed in docs/BUGS.md "Phase 4"): a real Klipy search, the Android WebView loading a `static.klipy.com` image, hardware back closing the sheet, and Element showing the title + link + preview card.

## 4. Walkthrough
Desktop and phone scripts are in docs/PHASE4_PLAN.md ("Desktop demo script", "Phone demo script"). Shortest version: log in as **alice** / **password123**, type `/gif tacos`, Enter, ArrowRight twice, Enter: the picker opens pre-searched, the third tile is picked, a `Sending GIF...` chip shows, and the GIF lands animated with a badge. `npm run gif:sample -- --room "#general:localhost"` posts one as bob live.

## 5. Scripts
| Command | What it does |
|---|---|
| `npm run gif:sample` | bob posts a mock GIF to `#dev` (`--room` to change) |
| `npm run verify:gif` | provider + send + read-back checks without a browser (30 checks; adds a live Klipy search when a key is set) |
| `npm run gif:fixtures` | regenerates `public/gif-fixtures/` |
| `npm run test:e2e:gif` | `e2e/gif.spec.ts` (desktop) and `e2e/mobile-gif.spec.ts` (phone) with the Klipy API and CDN stubbed |
