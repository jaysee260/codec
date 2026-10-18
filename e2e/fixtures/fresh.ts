/**
 * QA-7 — fresh-seed guard.
 *
 * A handful of criteria are written against the seed *as it comes out of `npm run seed`* and can
 * only be judged there:
 *
 *  - the initial ~30-event sync window of #general must still be the newest seeded messages
 *    (AC-B1-1, AC-B1-8, AC-B3-1 and demo steps 2/3/5/6 assert on rows inside that window);
 *  - #random must still carry its seeded 3 unread (docs/SEED_DATA.md).
 *
 * Both are consumed by ordinary use of the homeserver: every message anyone sends into #general
 * pushes the seeded events out of the window, and the first client that opens #random sends an
 * `m.read` receipt that cannot be moved back (see fixtures/state.ts).
 *
 * So those tests call `requireFreshSeed(test)`, which skips them with an actionable reason instead
 * of reporting a red criterion that says nothing about the product. Everything else in the suite is
 * written to tolerate a dirty homeserver (locate seeded rows by event id and page back to them,
 * locate new rows by text, derive unread counts instead of hard-coding them).
 *
 *   test('AC-B1-1 ...', async ({ page }) => {
 *     await requireFreshSeed(test);
 *     ...
 *   });
 *
 * The verdict is probed at the first guarded test of each spec file and reused for the rest of that file: a file's
 * own steps dirty both signals (smoke step 2 reads #random, step 4 posts into #general), so a re-probe per test would
 * skip later steps that were judged on a clean start. A file that runs after *another* file dirtied the same server
 * gets its own probe and skips honestly instead of failing on a window it cannot judge (BUG-24).
 *
 * Pool runs (issue #2): when global setup restored the homeserver pool it sets `E2E_POOL_RESTORED=1` and deletes
 * `e2e/tmp/fresh-w*.json`; each verdict is then also written to `e2e/tmp/fresh-w<i>-<spec file>.json`, so a worker
 * that Playwright restarts after a failure mid-file reuses the verdict taken at the start of that file instead of
 * re-probing a server the file's earlier tests dirtied. Without a restore (`E2E_REUSE_SERVERS`, a reused :8008, WSL1)
 * nothing is persisted and each worker process probes once per file.
 *
 * Thread replies do not count as "events after the seeded last message": the seed itself posts a late thread reply
 * into #general after `general.last` (seed/seed.ts, Phase 3), and thread replies never enter the main timeline window
 * (BUG-23).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { asUser, type MatrixEventJson } from './matrix-api.ts';
import { workerIndex } from './pool.ts';
import { eventId, resolveRoom } from './seed.ts';

const TMP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tmp');

/** Seeded unread for #random on a fresh seed (docs/SEED_DATA.md, AC-A5-1). */
const RANDOM_UNREAD_ON_FRESH_SEED = 3;

export const FRESH_SEED_HINT = 'requires a fresh seed: run npm run test:e2e:fresh';

export interface FreshSeedReport {
  fresh: boolean;
  /** Human-readable reasons the homeserver is not pristine (empty when it is). */
  reasons: string[];
  newestGeneralEvent?: string;
  randomUnread?: number;
}

/** Just enough of Playwright's `test` object to skip and annotate; pass the imported `test`. */
export interface FreshSeedTest {
  skip(condition: boolean, description: string): void;
  info(): { annotations: { type: string; description?: string }[] };
}

/** One verdict per spec file in this process (see checkFreshSeed). */
const probed = new Map<string, Promise<FreshSeedReport>>();

/** True for an event in a thread (`m.relates_to.rel_type === 'm.thread'`): it is not part of the main timeline. */
export function isThreadReply(event: MatrixEventJson): boolean {
  const rel = (event.content as { 'm.relates_to'?: { rel_type?: unknown } } | undefined)?.['m.relates_to'];
  return rel?.rel_type === 'm.thread';
}

/** The newest main-timeline event in a `/messages?dir=b` chunk (newest first), skipping thread replies. */
export function newestMainTimelineEvent(chunk: MatrixEventJson[]): MatrixEventJson | undefined {
  return chunk.find((event) => !isThreadReply(event));
}

/** Where the verdict for spec file `specFile` on pool instance `i` is persisted for the rest of the run. */
export function freshVerdictFile(i: number, specFile: string): string {
  return resolve(TMP_DIR, `fresh-w${i}-${basename(specFile).replace(/[^\w.-]/g, '_')}.json`);
}

/**
 * Returns the verdict persisted in `file` when there is one, otherwise runs `probe` and persists its result there
 * (atomically). With no `file`, just probes.
 */
export async function loadOrProbe(
  file: string | undefined,
  probe: () => Promise<FreshSeedReport>,
): Promise<FreshSeedReport> {
  if (file && existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as FreshSeedReport;
    } catch {
      // A torn or foreign file: fall through and probe (the write below replaces it).
    }
  }
  const report = await probe();
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(report));
    renameSync(tmp, file);
  }
  return report;
}

async function probeSeed(): Promise<FreshSeedReport> {
  const reasons: string[] = [];
  const alice = await asUser('alice');
  const general = await resolveRoom('general');
  const random = await resolveRoom('random');

  // 1. The newest event in #general is still the last seeded message (nothing was posted after it).
  const newest = newestMainTimelineEvent(await alice.messages(general, 50));
  const newestId = newest?.event_id;
  const expectedNewest = eventId('general.last');
  if (newestId !== expectedNewest) {
    reasons.push(
      `#general has events after the seeded last message (newest is ${newestId ?? 'none'}, expected ${expectedNewest})`,
    );
  }

  // 2. #random still carries its seeded unread for alice (no client has read it yet).
  const unread = await alice.unreadFor(random);
  if (unread.count !== RANDOM_UNREAD_ON_FRESH_SEED) {
    reasons.push(
      `alice's unread in #random is ${unread.count}, expected ${RANDOM_UNREAD_ON_FRESH_SEED} (a receipt already moved past the seeded messages)`,
    );
  }

  return { fresh: reasons.length === 0, reasons, newestGeneralEvent: newestId, randomUnread: unread.count };
}

/** The spec file of the running test (the verdict key); '' outside a test. */
function currentSpecFile(): string {
  try {
    return test.info().file;
  } catch {
    return '';
  }
}

/**
 * Probes the homeserver at the first guarded test of each spec file and reuses that verdict for the rest of the file
 * (BUG-24): a file's own earlier steps do not void its later guarded steps, and a file that runs after another file
 * dirtied the server skips honestly. After a pool restore the verdict is also persisted per (pool instance, file), so
 * a worker restarted mid-file reuses it.
 */
export function checkFreshSeed(specFile: string = currentSpecFile()): Promise<FreshSeedReport> {
  let verdict = probed.get(specFile);
  if (!verdict) {
    const file = process.env.E2E_POOL_RESTORED ? freshVerdictFile(workerIndex(), specFile) : undefined;
    verdict = loadOrProbe(file, probeSeed);
    probed.set(specFile, verdict);
  }
  return verdict;
}

/**
 * Skips the calling test unless the homeserver still holds a pristine seed.
 *
 * @param test the `test` object imported from `@playwright/test` (used for `skip`/`info`)
 * @returns the report, when the seed is fresh (otherwise the call throws Playwright's skip)
 */
export async function requireFreshSeed(test: FreshSeedTest): Promise<FreshSeedReport> {
  const report = await checkFreshSeed();
  if (!report.fresh) {
    test.info().annotations.push({
      type: 'needs-fresh-seed',
      description: `${FRESH_SEED_HINT}. ${report.reasons.join('; ')}.`,
    });
    test.skip(true, FRESH_SEED_HINT);
  }
  return report;
}
