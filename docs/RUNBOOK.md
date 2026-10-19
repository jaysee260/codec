# Runbook: every command, by task

All commands run from the repo root. The homeserver is a local Synapse on `http://localhost:8008`; `npm run hs:up` uses
Docker when it can and falls back to WSL1 on a Windows PC without virtualisation (`homeserver/README.md`). Nothing in
the client, seed or tests depends on how the homeserver is hosted, only on its URL.

Test users: `alice`, `bob`, `carol`, `dave`, all with password `password123`. What the seed creates is in `docs/SEED_DATA.md`.

## Start working

| I want to | Run |
|---|---|
| Install everything (also downloads Playwright's Chromium) | `npm install` |
| Start the homeserver (and the local call server) | `npm run hs:up` |
| Add the test users, rooms and messages | `npm run seed` (additive: safe to re-run, never touches `#vault`'s history) |
| Start the app on http://localhost:5173 | `npm run dev` |
| Stop the homeserver | `npm run hs:down` |
| Wipe the homeserver and reseed | `npm run seed:reset` (destructive: loses every E2EE room key) |
| Point the app at another homeserver | `.env`: `VITE_HS_URL=http://...`, or the login screen's Advanced field |

## Check my change

| I want to | Run |
|---|---|
| Type-check | `npm run typecheck` |
| Build for production | `npm run build` |
| Unit tests (pure modules, scripts) | `npm run test:unit` |
| The whole Playwright suite (starts a homeserver pool and the dev server itself) | `npm run test:e2e` |
| One area | `npm run test:e2e:smoke`, `:threads`, `:gif`, `:link-preview`, `:receipts`, `:e2ee`, `:calls`, `:calls:mobile` |
| Only desktop, or only the Pixel 7 profile | `npm run test:e2e:desktop`, `npm run test:e2e:mobile` |
| One test by name | `npx playwright test e2e/threads.spec.ts -g "AC-T2-3" --project=desktop` |
| Watch a run, or open the last report | `npm run test:e2e:headed`, `npm run test:e2e:ui`, `npm run test:e2e:report` |
| Fresh homeserver pool before the suite | `npm run test:e2e:fresh` |
| Check the Android build and manifest without a device | `npm run test:android-build` |

The suite runs one Synapse and one Vite per Playwright worker (`E2E_WORKERS` sizes it); pool commands are
`npm run hs:pool:up`, `:down`, `:status`, `:snapshot`, `:clean`. PRs run only the specs that touch the changed area
(`scripts/select-e2e.mjs`); the `full-e2e` label runs everything. `e2e/README.md` has the details.

## Phones

Full walkthrough in `docs/MOBILE.md`.

| I want to | Run |
|---|---|
| Let a phone on the same Wi-Fi reach the homeserver (prints the address to use) | `npm run hs:lan` |
| Serve the app to the phone's browser | `npm run dev:lan` |
| Find the JDK and Android SDK, and persist the paths | `npm run toolchain -- --setx` |
| Build the Android APK pointed at this PC | `npm run cap:build:android:lan` |
| Build the APK with `VITE_HS_URL` from the environment | `npm run cap:build:android` |
| Sync the web build into the native projects / open them | `npm run cap:sync`, `cap:copy:ios`, `cap:open:android`, `cap:open:ios` |
| Phone-shell check with screenshots (dev server on :5183) | `npm run dev -- --port 5183` then `npm run verify:phone` |

## Voice calls

| I want to | Run |
|---|---|
| Start, stop or inspect the local LiveKit + token service alone | `npm run rtc:up`, `rtc:down`, `rtc:status` |
| Download the pinned `livekit-server` (done on demand by `rtc:up`) | `npm run rtc:fetch` |
| Prove the whole call chain without a browser | `npm run rtc:probe` |
| Run the pool without call servers | `E2E_NO_RTC=1 npm run test:e2e` |

## Encryption

| I want to | Run |
|---|---|
| Post encrypted sample messages and an image into `#vault` as bob | `npm run e2ee:sample` |
| Verify encryption end to end (attachment round trip, wire shape, ciphertext on the server) | `npm run verify:e2ee` |

Both honour `HS_URL` and `PASSWORD`. In the browser, `__matrixPoc.security.importRoomKeys(json)` decrypts the sample
history at once.

## Sample content and fixtures

| I want to | Run |
|---|---|
| Post a voice note through the API and validate it | `npm run voice:sample` |
| Post a thread (root + replies) through the API | `npm run thread:sample [-- --room '#general:localhost' --replies 3 --as bob,carol]` |
| Post a GIF message through the API | `npm run gif:sample [-- --id mock-3 --room '#general:localhost']` |
| Regenerate the mock GIF fixtures (byte-stable) | `npm run gif:fixtures` |
| Regenerate the link-preview fixture images | `npm run preview:fixtures` |
| Rebuild the e2e test assets | `npm run test:e2e:fixtures` |
| No-browser checks of the GIF or thread core (dev server on :5183 for threads) | `npm run verify:gif`, `npm run verify:threads` |

Scripts never post in `#general` by default; sample posters target `#dev`.

## Settings (`.env`, copy from `.env.example`)

| Variable | What it does |
|---|---|
| `VITE_HS_URL` | The homeserver the app connects to (default `http://localhost:8008`). The login screen's Advanced field overrides it at runtime. |
| `VITE_GIF_API_KEY` | A Klipy key. Unset = the built-in mock GIFs. |
| `VITE_GIF_API_BASE` | Point the GIF provider at a stub origin (tests). |
| `VITE_RTC_FOCUS_URL` | Force a call server instead of discovering it from the homeserver. |
| `HS_URL`, `PASSWORD` | Used by the seed and the scripts, not by the app. |

Runtime overrides for QA live in localStorage: `matrix-poc.gifApiKey`, `matrix-poc.gifProvider` (`klipy` or `mock`,
wins over keys), `matrix-poc.rtcFocusUrl`, `matrix-poc.hsUrl`.
