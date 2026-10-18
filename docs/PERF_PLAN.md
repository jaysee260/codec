# PERF plan — faster e2e runs (issue #2)

Owner: PM. Status: **draft, wave 1** (numbers and "Your steps" are filled in later).

## Problem

The Playwright suite (~285 tests, `desktop` + `mobile`) runs on **one worker against one Synapse**: ~50 min
desktop + ~20 min phone on a clean server, up to ~2 h on a dirty one (BUG-4 slowdown + "requires a fresh seed" skips).

## Design

One Synapse + one Vite dev server **per Playwright worker**, all byte-copies of one seeded snapshot.

- **Seed once, snapshot.** Seed a template homeserver with the existing `seed/seed.ts`, stop it, snapshot the
  data dir (SQLite DB, media store, signing key, secrets). Cache it; re-seed only when `seed/seed.ts`, the
  homeserver config or the seed assets change (content hash).
- **N clones.** For N workers, restore the snapshot into N data dirs and start N Synapse processes on `8008+i`
  (`i` = Playwright parallel index), each with its own generated config (port, db/media paths, pid/log,
  `public_baseurl`). Same bytes → `seed/seed-output.json` and `seed/e2ee-keys.json` are valid on every clone.
- **N Vite servers** on `5173+i`, each with `VITE_HS_URL=http://localhost:${8008+i}`.
- **Worker routing.** `TEST_PARALLEL_INDEX` picks the worker's `HS_URL` (`e2e/fixtures/seed.ts`) and `baseURL`
  (`playwright.config.ts`). The hard-coded `http://localhost:5173` ORIGIN constants (gif / mobile-gif / smoke
  specs, `fixtures/gif.ts`, `fixtures/e2ee.ts`) follow the worker's baseURL.
- **Fresh every run.** Each run restores from the snapshot, so no accumulated state (fixes BUG-4 and the
  fresh-seed skips). Opt-out env reuses already-running servers for dev loops.
- **Workers.** `workers` defaults to something sensible for the machine; `E2E_WORKERS` overrides;
  `E2E_WORKERS=1` = today's layout (one Synapse on 8008, one Vite on 5173).
- **Backends.** Native Synapse via Python venv (cloud container, Linux CI) and Docker (JC's machines).
  WSL1 (`homeserver/wsl`) falls back to 1 worker with a clear message.
- **Not changed:** no test skipped, disabled, weakened or given a looser budget; `src/` untouched;
  `.github/workflows/*` untouched (CI thread owns them — see "What CI needs").

## Acceptance criteria (QA checks each; all must hold on the same run)

1. **PERF-1 Wall time.** A full clean run (`npm run test:e2e`, both projects) finishes in **< 20 min** on a
   4-core box with the default worker count.
2. **PERF-2 Same tests.** The test list of a 1-worker `npx playwright test --list` equals the set of tests
   executed by the N-worker run (same count, same titles, both projects). No test removed or renamed. A long
   spec file may be split into several files only by moving tests verbatim (serial groups stay together).
3. **PERF-3 No new skips.** Skipped count in the N-worker run ≤ the 1-worker baseline on a fresh seed, and
   no new skip reasons appear. In particular **zero** `requires a fresh seed` skips and zero `needs-fresh-seed`
   annotations.
4. **PERF-4 Zero cross-worker interference.** Each worker talks only to its own Synapse/Vite pair (verify:
   ports in traces / `page.on('request')` hosts match `8008+i` / `5173+i` for that worker). No test observes a
   room, event, receipt or unread count created by another worker. Running the suite twice in a row gives the
   same result.
5. **PERF-5 Every run starts fresh.** After a run, start another without manual `seed:reset`: it still passes
   PERF-3 (clones are restored from the snapshot, not reused dirty). The template is re-seeded when
   `seed/seed.ts`, `homeserver/homeserver.yaml` or seed assets change, and **not** otherwise (check the
   cache hit/miss message).
6. **PERF-6 Timing criteria unchanged.** Every timed criterion keeps its original budget and passes at N
   workers on the 4-core box (e.g. AC-SH-2 login < 10 s, drawer < 300 ms, AC-T2-6 echo, "within 3 s" polls).
   No `timeout`, `expect.timeout`, `actionTimeout` or per-test budget is raised. Spec assertions are
   byte-for-byte those of PR #3's branch except for the ORIGIN/baseURL change and new regression tests.
7. **PERF-7 `E2E_WORKERS=1` still works.** Single Synapse on 8008, single Vite on 5173, the full suite passes,
   and the existing single-criterion commands in `e2e/README.md` still work unchanged.
8. **PERF-8 Docker backend.** With Docker as the homeserver backend (no venv), the N-worker run starts N
   containers/instances on `8008+i` from the same snapshot and passes PERF-2..PERF-6. (Verified on JC's
   machine or a Docker-capable CI runner; the cloud container has no Docker daemon.)
9. **PERF-9 WSL fallback.** On the WSL1 backend the run falls back to 1 worker and prints one clear line
   saying so and why, before any test starts; the suite then behaves as PERF-7.
10. **PERF-10 Cleanup.** Teardown stops every Synapse and Vite it started (no orphan processes/containers,
    ports 8008–8015 / 5173–5180 free afterwards); a crashed run leaves nothing that blocks the next one.
11. **PERF-11 Regression tests.** Every bug found while doing this has a regression test in `e2e/*.spec.ts`
    in the same change, and `docs/BUGS.md` is updated.

## Before / after

| Run | Before (1 worker, PR #3 branch) | After (N workers) | Target |
|---|---|---|---|
| Full suite, clean server, 4-core | _TBD_ (~70 min: ~50 desktop + ~20 phone) | _TBD_ | < 20 min |
| Full suite, dirty server | _TBD_ (up to ~2 h) | n/a — every run is fresh | n/a |
| Desktop project only | _TBD_ (~50 min) | _TBD_ | — |
| Mobile project only | _TBD_ (~20 min) | _TBD_ | — |
| Tests listed / run / skipped | _TBD_ / _TBD_ / _TBD_ | _TBD_ / _TBD_ / _TBD_ | equal / equal / ≤ |
| Seed → snapshot (first run only) | n/a | _TBD_ | — |
| Snapshot restore + N servers up | n/a | _TBD_ | — |

"Before" numbers come from the other thread's final run on PR #3's branch; "after" from QA's run on this
branch, same machine class. Workers used: _TBD_.

## Your steps (JC) — to be finalised

```bash
npm run test:e2e            # full suite, N workers, fresh clones, < 20 min   (final command TBD)
E2E_WORKERS=1 npm run test:e2e   # old single-server behaviour
# dev loop against already-running servers: opt-out env TBD
```

Prerequisites, worker default, and the dev-loop opt-out will be filled in once the pool script lands.

## What CI needs (owned by the CI thread — not edited here)

- A Synapse backend on the runner: Python 3 + `pip install matrix-synapse` (pinned to the version the pool
  script is tested with, 1.163 here) into a venv, **or** Docker available. The pool script must be told which
  (env, name TBD) and where the venv lives.
- `E2E_WORKERS` set to the runner's core count (or leave the default); `CI=1` keeps `forbidOnly`/retries.
- `npx playwright install --with-deps chromium` (Playwright 1.63).
- Cache the seed snapshot keyed by the same content hash the script uses (optional; the first-run seed costs
  _TBD_ min).
- Ports 8008–8015 and 5173–5180 free on the runner.
