/**
 * TEMPORARY local copy of the Shared API's `formatRelative(ts)` (docs/PHASE3_TICKETS.md
 * "src/lib/format.ts | formatRelative(ts)"). The helper is not in `src/lib/format.ts` yet and
 * `src/lib/**` is the Principal's, so DEV-A-17 ships this until the request in the Dev A report
 * ("Request to Principal: src/lib/format.ts, formatRelative(ts), ...") lands.
 *
 * The strings are the ones pinned by the PM's advisor consult #3 (docs/PHASE3_PLAN.md):
 *   `just now` (< 60 s) | `N min ago` | `N h ago` | `yesterday` | else the short date.
 *
 * Dev B needs the same strings for `thread-summary-time` (AC-T4-2 asserts `just now`), so as soon as
 * the core helper exists this file must be deleted and `formatRelative` imported from `@/lib/format.ts`
 * - two copies will drift.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/**
 * Relative age of a timestamp for thread lists and summary rows.
 * `now` is injectable for tests; clock skew into the future reads as `just now`.
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  if (!ts) return '';
  const diff = now - ts;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (isSameDay(ts, now - DAY)) return 'yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** `1 reply` / `N replies` - the wording Dev B's `thread-summary-count` uses too (AC-T4-2/T4-5). */
export function replyCountText(count: number): string {
  return count === 1 ? '1 reply' : `${count} replies`;
}
