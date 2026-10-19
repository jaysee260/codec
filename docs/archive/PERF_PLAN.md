# PERF plan — faster e2e runs (issue #2)

Owner: PM. Status: **done on branch `claude/faster-tests-86276o`** — full suite in **11 min 53 s** (was ~50 min clean,
1.6–2 h dirty), 300 tests, 290 passed / 0 failed / 10 skipped, 3 workers on a 4-core box. Docker backend and the
WSL1 fallback are implemented but not verified on real hardware (see PERF-8/9).

## Problem

The Playwright suite (~290 tests, `desktop` + `mobile`) ran on **one worker against one Synapse**: 40 min desktop +
10 min phone on a clean server, 1.6–2 h on a dirty one (BUG-4 slowdown) plus "requires a fresh seed" skips.

## Design

One Synapse + one Vite dev server **per Playwright worker**, all byte-copies of one seeded snapshot (`scripts/hs-pool.mjs`,
`e2e/global-setup.ts`, `e2e/fixtures/pool.ts`).

- **Seed once, snapshot.** Seed a template homeserver with `seed/seed.ts` (+ the E2EE sample, read by alice), stop it,
  snapshot the data dir (SQLite DB, media, signing key, secrets) under `homeserver/data/pool/`. Cached by a content hash of
  `seed/seed.ts`, `homeserver/homeserver.yaml`, seed assets, sample script and Synapse version; first build ~13 s.
- **N clones.** Global setup restores the snapshot into N data dirs and starts N Synapses on `8008+i` with generated
  per-instance configs (port, paths, pid/log, `public_baseurl`). Same bytes → `seed/seed-output.json` and
  `seed/e2ee-keys.json` are valid on every clone. Restore + 3 servers ready: ~2 s.
- **N Vite servers** on `5173+i`, each with `VITE_HS_URL=http://localhost:${8008+i}`.
- **Worker routing.** `TEST_PARALLEL_INDEX` picks each worker's `HS_URL` and `baseURL`; the former hard-coded
  `localhost:5173` origins follow the worker's baseURL.
- **Fresh every run.** Clones are restored from the snapshot on every run; teardown stops everything.
  `E2E_REUSE_SERVERS=1` opts out for dev loops.
- **Workers.** Default `max(1, min(4, cpus-1))` (3 on 4 cores); `E2E_WORKERS=N` overrides; `E2E_WORKERS=1` = old layout
  (8008 / 5173, reuses a homeserver already on 8008).
- **Backends.** Native Synapse from `homeserver/.venv` (Linux, CI, this container) or Docker; Windows with only the
  WSL1 homeserver drops to 1 worker with a message.
- **Long spec files split verbatim** (conversation, e2ee-core, e2ee-security) so files balance across workers; same
  titles, assertions and count (ruling in `/home/claude/team/CONSULTS.md`).
- **Not changed:** no test skipped, disabled, weakened or given a looser budget. `src/` changed once, for a real product
  bug the fresh guard had been hiding (BUG-28).

## Acceptance criteria — result (run 3, 3 workers, 4-core container)

| id | criterion | result |
|---|---|---|
| PERF-1 | Full clean run < 20 min on a 4-core box, default workers | **Met** — 11 min 53 s (run 1: 19:04, run 2: 12:09) |
| PERF-2 | 1-worker `--list` == set of tests the N-worker run executes | **Met** — 300 = 219 desktop + 81 mobile, identical lists; 293 before + 7 regression tests |
| PERF-3 | Fewer skips than the serial baseline; every fresh-seed skip names the spec file that dirtied its server (orchestrator ruling) | **Met** — 10 skipped vs 18 skipped/not-run serially; 5 by design (manual/fixme, same as before), 5 fresh-seed skips each naming the writer, time and spec file (`fixtures/run-log.ts`; regression `test-harness` PERF-3) |
| PERF-4 | Zero cross-worker interference | **Met** — 0 failures; each server served only its worker; every skip cause is a file from the same worker; runs 2→3 stable |
| PERF-5 | Every run starts fresh; snapshot rebuilt only on hash change | **Met** — runs 2 and 3 ran on a cache hit without manual reset, no BUG-4 slowdown |
| PERF-6 | Timing criteria and all timeouts unchanged | **Met** — AC-SH-2, drawer, echo, "within 3 s" all green; no budget raised; the only `src/` change is BUG-28 |
| PERF-7 | `E2E_WORKERS=1` still works | **Met** — used for every serial recheck (BUG-28/29, run-1 failure triage) |
| PERF-8 | Docker backend, N instances from the same snapshot | **Not verified** — implemented (`scripts/lib/hs-docker.mjs`, `HS_POOL_BACKEND=docker`); no Docker daemon in this container. Needs a run on JC's machine |
| PERF-9 | WSL1 falls back to 1 worker with one clear message | **Partly met** — logic in `fixtures/pool.ts` (`E2E_POOL_FALLBACK`), message tells you to `npm run hs:up`/`test:e2e:fresh`; simulated only, not run on Windows |
| PERF-10 | Teardown leaves no orphans; ports 8008–8015 / 5173–5180 free | **Met** — three consecutive runs with no port conflicts; `npm run hs:pool:status` / `hs:pool:clean` for the crashed case |
| PERF-11 | Every bug found has a regression test and a BUGS.md entry | **Met** — BUG-23..29 in `docs/BUGS.md`; 7 regression tests (6 `test-harness`, 1 `conversation-timeline`) |

## Before / after

| | Before (1 worker, PR #3 run 4, fresh server) | After (3 workers, run 3) |
|---|---|---|
| Full suite wall time | **~50 min** (desktop 40.0 + mobile 10.1) | **11 min 53 s** (4.2x) |
| Full suite, dirty server | 1.6–2 h | n/a — every run is fresh |
| Tests run / passed / failed / skipped | 290 / 270 (189+81) / 2 / 18 | 300 / 290 (209+81) / 0 / 10 |
| Fresh-seed skips | 7 (always, even on a pristine seed — BUG-23) | 5, each naming its cause |
| Snapshot build (first run only) | n/a | 13 s |
| Restore + 3 Synapse ready | n/a | ~2 s |

Remaining long pole: `threads.spec.ts` (5.5 min on one worker, starts ~6 min in); scheduling it first could save 1–2 min.

## Your steps (JC)

One-time, Linux/macOS (or just have Docker running):

```bash
python3 -m venv homeserver/.venv && homeserver/.venv/bin/pip install 'matrix-synapse[url-preview]'
```

Then:

```bash
npm run test:e2e                 # fresh snapshot clones, 3 workers on 4 cores, ~12 min
E2E_WORKERS=2 npm run test:e2e   # any worker count; =1 is the old single-server layout
E2E_REUSE_SERVERS=1 npm run test:e2e   # dev loop: use whatever is already running
npm run hs:pool:status           # what is up; hs:pool:clean after a crash
```

Windows with the WSL1 homeserver only: `npm run hs:up` first; the run drops to 1 worker and says so.

## CI

Already changed in this branch (`.github/workflows/ci.yml`, other thread): `playwright install --with-deps chromium`,
`python -m venv homeserver/.venv && pip install 'matrix-synapse[url-preview]'`, then `npm run test:e2e` with the
default worker count; pool logs are tailed on failure. Optional later: cache `homeserver/data/pool/` by the snapshot hash.
