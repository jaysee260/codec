/**
 * Which spec files used this worker's homeserver, and when (issue #2, PERF-3 ruling).
 *
 * The fresh-seed guard (fresh.ts) may skip a test only when it can name the spec file that dirtied the server. Every
 * fixture entry point that talks to the homeserver (matrix-api `request`, `loginAs`, `loginWith`, `apiLogin`) calls
 * `noteServerUse()`, which records the running test's spec file the first time it is seen in a row. After a pool
 * restore (`E2E_POOL_RESTORED`) the log is appended to `e2e/tmp/ran-w<i>.jsonl`, shared by every worker process of
 * pool instance i and cleared by global setup; otherwise it lives in this process only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { workerIndex } from './pool.ts';

export interface RunLogEntry {
  /** Spec file name, e.g. `navigation.spec.ts`. */
  file: string;
  /** Epoch ms when that file first used the server (this machine's clock, the same one Synapse stamps events with). */
  t: number;
}

const TMP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tmp');
const memory: RunLogEntry[] = [];
let lastFile = '';

export function runLogFile(i: number): string {
  return resolve(TMP_DIR, `ran-w${i}.jsonl`);
}

/** Records that the running test's spec file is using the homeserver (no-op outside a test, or for the same file). */
export function noteServerUse(): void {
  let file: string;
  try {
    file = basename(test.info().file);
  } catch {
    return;
  }
  if (file === lastFile) return;
  lastFile = file;
  const entry: RunLogEntry = { file, t: Date.now() };
  memory.push(entry);
  if (process.env.E2E_POOL_RESTORED) {
    const path = runLogFile(workerIndex());
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  }
}

/** The log for this worker's homeserver, oldest first. */
export function readRunLog(): RunLogEntry[] {
  if (!process.env.E2E_POOL_RESTORED) return [...memory];
  const path = runLogFile(workerIndex());
  if (!existsSync(path)) return [];
  const out: RunLogEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunLogEntry);
    } catch {
      // a torn last line from a crashed worker
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The spec file that was using the server at time `ts` (the latest entry at or before it), if any. */
export function fileActiveAt(log: RunLogEntry[], ts: number): string | undefined {
  let found: string | undefined;
  for (const entry of log) {
    if (entry.t <= ts) found = entry.file;
    else break;
  }
  return found;
}

/** Distinct files in log order, for "files that used this server before" lists. */
export function filesInLog(log: RunLogEntry[]): string[] {
  return [...new Set(log.map((e) => e.file))];
}
