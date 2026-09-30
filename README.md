# Matrix POC - a Discord-like chat client on Synapse

Vite + React 18 + TypeScript + matrix-js-sdk + zustand. Local Synapse (Docker, or WSL1 where Docker cannot run). No E2EE, no voice.

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
| `scripts/` | Principal | `hs.mjs` homeserver wrapper (docker or wsl backend), `verify-scaffold.mjs` smoke script |
| `src/lib/` | Principal | Matrix client lifecycle, actions, read helpers, formatting |
| `src/store/` | Principal | zustand stores + SDK event bridge + hooks |
| `src/app/` | Principal | session gate, login, shell layout, theme tokens |
| `src/features/navigation/` | Dev A | space rail, channel sidebar, DM list, header, member panel |
| `src/features/conversation/` | Dev B | message list, composer, reactions, replies, uploads |
| `e2e/`, `playwright.config.ts` | QA | Playwright suite |
| `docs/` | PM / Principal | PLAN, SEED_DATA, ACCEPTANCE, TICKETS, STATUS, ARCHITECTURE |

Read `docs/ARCHITECTURE.md` before touching anything: it is the contract for the shared layer.
