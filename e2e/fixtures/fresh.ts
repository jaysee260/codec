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
 * The verdict is probed once per worker process and cached: the run itself dirties both signals
 * (the very first test that posts into #general moves the window), so a later re-probe would
 * report "dirty" for a run that started clean and would skip tests that should have run.
 */
import { asUser } from './matrix-api.ts';
import { eventId, resolveRoom } from './seed.ts';

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

let probed: Promise<FreshSeedReport> | undefined;

async function probeSeed(): Promise<FreshSeedReport> {
  const reasons: string[] = [];
  const alice = await asUser('alice');
  const general = await resolveRoom('general');
  const random = await resolveRoom('random');

  // 1. The newest event in #general is still the last seeded message (nothing was posted after it).
  const newest = (await alice.messages(general, 1))[0];
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

/** Probes the homeserver once per worker and caches the verdict for the rest of the run. */
export function checkFreshSeed(): Promise<FreshSeedReport> {
  probed ??= probeSeed();
  return probed;
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
