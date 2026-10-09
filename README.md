# Matrix POC - a Discord-like chat client on Synapse

Vite + React 18 + TypeScript + matrix-js-sdk + zustand. Local Synapse (Docker, or WSL1 where Docker cannot run). No E2EE, no calls.
Phase 2 adds a phone layout, voice notes (MSC3245) and Capacitor 7 wrappers for Android and iOS.
Phase 3 adds threads (Matrix `m.thread`, Slack/Element semantics, Discord-style panel); `npm run thread:sample` posts one to #dev through the API and `npm run verify:threads` checks the core on port 5183 (`docs/ARCHITECTURE.md` "Phase 3 deltas").
Phase 4 adds a Slack-style GIF picker backed by [Klipy](https://docs.klipy.com/) (`VITE_GIF_API_KEY` in `.env`; without a key a built-in mock with 8 local fixture GIFs runs the whole flow); GIFs are hot-linked (`m.text` + `dev.matrixpoc.gif`), never uploaded; `npm run gif:sample` posts one to #dev and `npm run verify:gif` checks the core without a browser (`docs/ARCHITECTURE.md` "Phase 4 deltas").

## Quickstart (5 commands)

```bash
npm install                 # also installs Playwright's Chromium (postinstall)
npm run hs:up               # start Synapse on http://localhost:8008 (Docker, or the WSL1 fallback)
npm run seed                # create alice/bob/carol/dave, the Acme HQ + Gaming spaces, DMs, history
npm run dev                 # http://localhost:5173  -> log in as alice / password123
npm run test:e2e            # Playwright suite (QA)
```

Other scripts: `npm run typecheck`, `npm run build`, `npm run hs:down`, `npm run hs:reset`,
`npm run seed:reset` (wipe + reseed), `node scripts/hs.mjs logs`.

Seed users: `alice`, `bob`, `carol`, `dave`, all with password `password123` (see `docs/SEED_DATA.md`).

## On a phone (Phase 2) - full guide in `docs/MOBILE.md`

```bash
npm run hs:lan                      # LAN proxy 0.0.0.0:8009 -> Synapse; prints http://<PC-IP>:8009 and the app URL
npm run dev:lan                     # Vite on 0.0.0.0:5173 -> open http://<PC-IP>:5173 on the phone, Advanced > Homeserver URL = http://<PC-IP>:8009
npm run toolchain                   # checks JDK 21 + Android SDK (portable installs under ~/jdk21 and ~/android-sdk)
npm run cap:build:android:lan       # Android debug APK with the LAN homeserver baked in -> android/app/build/outputs/apk/debug/app-debug.apk
npm run voice:sample                # bob posts a voice note to #dev through the API (demo / QA fixture)
```

Accept the Windows Firewall prompt (Private networks) the first time node binds `0.0.0.0`. The phone browser path
shows the layout and plays voice notes; recording needs the APK (secure context). iOS: project generated under
`ios/`, built on a Mac (`docs/MOBILE.md` section 4). Capacitor 7 (`capacitor.config.ts`), JDK 21, Android SDK 35.

## Homeserver: two ways to run it

`npm run hs:up|hs:down|hs:reset` (`scripts/hs.mjs`) picks a backend automatically (`HS_BACKEND=docker|wsl` forces one):

| Backend | When | How |
|---|---|---|
| **Docker** (preferred) | `docker info` works (Docker Desktop with WSL2/Hyper-V, i.e. virtualization enabled in firmware) | `homeserver/docker-compose.yml`, image `ghcr.io/element-hq/synapse:latest`, config `homeserver/homeserver.yaml` mounted at `/data/homeserver.yaml`, runtime data in `homeserver/data/` |
| **WSL1** (fallback) | No virtualization (Docker Desktop reports `hasNoVirtualization`, WSL2 cannot start) | Synapse installed natively in a WSL1 Debian distro `matrix-hs` via `homeserver/wsl/hs.sh install`; same settings as the Docker config |

Both listen on http://localhost:8008 with server name `localhost`; the client, seed and tests only ever use
`VITE_HS_URL` / `HS_URL` (default `http://localhost:8008`). Details in `homeserver/README.md` and `homeserver/wsl/README.md`.

## Where things live

| Path | Owner | Purpose |
|---|---|---|
| `homeserver/` | Principal | `homeserver.yaml` (single Synapse config), `docker-compose.yml`, `wsl/` fallback scripts, `data/` runtime (ignored) |
| `seed/` | Principal | `seed.ts` fixture script, `seed-output.json` (generated, ids for QA) |
| `scripts/` | Principal | `hs.mjs` homeserver wrapper (docker or wsl backend), `lan-proxy.mjs`, `toolchain.mjs`, `cap-build-android.mjs`, `send-voice-sample.mjs`, `verify-phone-shell.mjs`, `verify-scaffold.mjs` |
| `src/lib/` | Principal | Matrix client lifecycle, actions (incl. `sendVoiceMessage`), read helpers (incl. `getVoiceMessage`), formatting, `audio/` voice primitives, `native.ts` Capacitor glue |
| `src/store/` | Principal | zustand stores (session, rooms, timeline, layout) + SDK event bridge + hooks |
| `src/app/` | Principal | session gate, login (+ homeserver override), desktop/phone shell, drawers, theme tokens |
| `capacitor.config.ts`, `android/`, `ios/` | Principal | Capacitor 7 config and generated native projects (build outputs ignored) |
| `src/features/navigation/` | Dev A | space rail, channel sidebar, DM list, header, member panel |
| `src/features/conversation/` | Dev B | message list, composer, reactions, replies, uploads |
| `e2e/`, `playwright.config.ts` | QA | Playwright suite |
| `docs/` | PM / Principal | PLAN, SEED_DATA, ACCEPTANCE, TICKETS, STATUS, ARCHITECTURE |

Read `docs/ARCHITECTURE.md` before touching anything: it is the contract for the shared layer.
