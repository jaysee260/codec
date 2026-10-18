/**
 * Per-worker server selection for parallel runs (issue #2, docs/PERF_PLAN.md).
 *
 * The run has N workers (`E2E_WORKERS`, default below). Worker i (Playwright's `TEST_PARALLEL_INDEX`, 0..N-1)
 * talks to its own Synapse on 8008+i and its own Vite dev server on 5173+i; every Synapse is a byte copy of the same
 * seeded snapshot (scripts/hs-pool.mjs), so seed ids are valid everywhere. With N = 1 nothing changes from the
 * single-server days: 8008 / 5173, and `E2E_HS_URL` / `HS_URL` / `E2E_BASE_URL` are still honoured.
 *
 * This module is imported by playwright.config.ts (main process and every worker process re-evaluate the config, after
 * `TEST_PARALLEL_INDEX` is set) and by the fixtures, so both sides compute the same URLs from the same env.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const BASE_HS_PORT = 8008;
export const BASE_APP_PORT = 5173;
/** Upper bound: ports 8008–8015 / 5173–5180 are reserved for the pool (team brief). */
export const MAX_WORKERS = 8;

/**
 * Default worker count when `E2E_WORKERS` is unset. Each worker is a Synapse + a Vite + one or two Chromium contexts,
 * and the timing budgets (login < 10 s, drawer < 300 ms, e2ee timeouts) are the first casualties of CPU contention,
 * so leave one core free. Tune by measurement (scripts/hs-pool.mjs `defaultWorkers` mirrors this for manual use).
 */
export function defaultWorkers(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}

export function poolSize(): number {
  const raw = process.env.E2E_WORKERS;
  if (raw === undefined || raw === '') return defaultWorkers();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS) {
    throw new Error(`E2E_WORKERS must be an integer 1..${MAX_WORKERS}, got "${raw}"`);
  }
  return n;
}

/** This process's worker index (0 in the main process and in single-worker runs). */
export function workerIndex(): number {
  const raw = process.env.TEST_PARALLEL_INDEX;
  const i = raw ? Number(raw) : 0;
  if (i >= poolSize()) {
    throw new Error(
      `worker ${i} has no homeserver: the pool has ${poolSize()} server(s). Set the worker count with E2E_WORKERS (not --workers), it sizes the servers too.`,
    );
  }
  return i;
}

export function hsUrlFor(i: number): string {
  if (poolSize() === 1) return (process.env.E2E_HS_URL ?? process.env.HS_URL ?? `http://localhost:${BASE_HS_PORT}`).replace(/\/+$/, '');
  return `http://localhost:${BASE_HS_PORT + i}`;
}

export function baseUrlFor(i: number): string {
  if (poolSize() === 1) return (process.env.E2E_BASE_URL ?? `http://localhost:${BASE_APP_PORT}`).replace(/\/+$/, '');
  return `http://localhost:${BASE_APP_PORT + i}`;
}

/** The app origin this worker's pages run on; the mock GIF provider builds its URLs from `location.origin`. */
export function workerOrigin(): string {
  return baseUrlFor(workerIndex());
}

/**
 * The room-key export file this worker's `scripts/send-encrypted-sample.mjs` runs merge into and AC-E7-3 imports.
 * Worker 0 keeps `seed/e2ee-keys.json`; the others get a private copy under `e2e/tmp/` (seeded from the snapshot's
 * file) so concurrent merges cannot tear each other's writes.
 */
export function e2eeKeysFile(): string {
  const shared = resolve(REPO, 'seed/e2ee-keys.json');
  const i = workerIndex();
  if (i === 0) return shared;
  const own = resolve(REPO, `e2e/tmp/e2ee-keys.w${i}.json`);
  // (Re)seed the copy whenever the shared file is newer: hs-pool `up` rewrites it from the snapshot on every run.
  if (existsSync(shared) && (!existsSync(own) || statSync(own).mtimeMs < statSync(shared).mtimeMs)) {
    mkdirSync(dirname(own), { recursive: true });
    copyFileSync(shared, own);
  }
  return own;
}

/**
 * Points child processes the fixtures spawn (`scripts/send-encrypted-sample.mjs` via `runSample`) at this worker's
 * servers. Called once at module load from `fixtures/seed.ts`, which every spec imports.
 */
export function exportWorkerEnv(): void {
  const i = workerIndex();
  process.env.HS_URL = hsUrlFor(i);
  process.env.E2E_BASE_URL = baseUrlFor(i);
  process.env.E2EE_KEYS_FILE = e2eeKeysFile();
}
