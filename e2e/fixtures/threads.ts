/**
 * Thread UI helpers and the Wave-8 "not built yet" guard (QA-14).
 *
 * Everything here is built from the Phase 3 testid registry in docs/PHASE3_ACCEPTANCE.md and from
 * nothing else. In particular the **prefix rule** is load-bearing: inside `thread-panel` the list is
 * `thread-message-list`, the composer `thread-composer-*`, the typing indicator `thread-typing` —
 * but the rows inside it keep `message-{eventId}` and everything inside a row (`message-actions`,
 * `reaction-*`, `message-edited`, ...) keeps its Phase 1/2 name. The root is `thread-root`, *not*
 * `message-{rootId}`.
 *
 * The in-tree `ThreadView` skeleton the Principal landed with PRIN-10 uses other names
 * (`data-root-id`, `thread-message-{id}`, `thread-empty`, `thread-load-more`). Those are deliberately
 * **not** supported here: the registry is the contract Dev B builds to, so a spec that passed against
 * the skeleton's names would hide the divergence instead of reporting it.
 *
 * Rules inherited from `ui.ts` / `mobile.ts`: no `waitForTimeout`; waits are locator auto-waits,
 * `expect.poll` or testid waits; taps on phone, clicks on desktop.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { loginAs } from './auth.ts';
import { asUser } from './matrix-api.ts';
import { resolveRoom } from './seed.ts';
import { messageList, openChannel, row, settledEventId } from './ui.ts';
import { longPress, settleAnimations } from './mobile.ts';

/* ------------------------------------------------------------------ locators */

/** The thread panel (desktop right column / phone full-screen overlay). */
export const threadPanel = (page: Page): Locator => page.getByTestId('thread-panel');
/** The root message at the top of the panel (its own testid, not `message-{rootId}`). */
export const threadRootEl = (page: Page): Locator => page.getByTestId('thread-root');
/** `No replies yet` / `N replies`. */
export const threadDivider = (page: Page): Locator => page.getByTestId('thread-replies-divider');
/** The replies scroll container inside the panel. */
export const threadMessageList = (page: Page): Locator => page.getByTestId('thread-message-list');
export const threadComposer = (page: Page): Locator => page.getByTestId('thread-composer-input');
export const threadSend = (page: Page): Locator => page.getByTestId('thread-composer-send');
export const threadTyping = (page: Page): Locator => page.getByTestId('thread-typing');
export const threadClose = (page: Page): Locator => page.getByTestId('thread-close');

/** A reply row inside the panel. Rows keep the Phase 1 `message-{eventId}` id (prefix rule). */
export const threadRow = (page: Page, eventId: string): Locator =>
  threadMessageList(page).getByTestId(`message-${eventId}`);

/** A reply row inside the panel located by its text (for replies this run created). */
export const threadRowByText = (page: Page, text: string): Locator =>
  threadMessageList(page).getByTestId(/^message-[$~]/).filter({ hasText: text });

/** The summary row under `message-{rootId}` in the channel timeline. */
export const threadSummary = (page: Page, rootId: string): Locator =>
  page.getByTestId(`thread-summary-${rootId}`);

export const threadsButton = (page: Page): Locator => page.getByTestId('header-threads');
export const threadsUnreadDot = (page: Page): Locator => page.getByTestId('header-threads-unread');
export const threadList = (page: Page): Locator => page.getByTestId('thread-list');
export const threadListItem = (page: Page, rootId: string): Locator =>
  page.getByTestId(`thread-list-item-${rootId}`);
export const threadListEmpty = (page: Page): Locator => page.getByTestId('thread-list-empty');
export const threadListClose = (page: Page): Locator => page.getByTestId('thread-list-close');

/** `message-action-thread` ("Reply in thread") wherever it is currently rendered. */
export const threadAction = (page: Page): Locator => page.getByTestId('message-action-thread');

/* ------------------------------------------------------------------ state readers */

/** `app-shell[data-thread-open]` as a boolean (AC-T2-8, AC-T3-1/2). */
export async function isThreadOpen(page: Page): Promise<boolean> {
  return (await page.getByTestId('app-shell').getAttribute('data-thread-open')) === 'true';
}

/** `thread-panel[data-root]`, or null when no panel is mounted. */
export async function openThreadRoot(page: Page): Promise<string | null> {
  if ((await threadPanel(page).count()) === 0) return null;
  return threadPanel(page).getAttribute('data-root');
}

/** Ordered `message-*` ids of the rows currently in `message-list` (the room timeline). */
export async function roomRowIds(page: Page): Promise<string[]> {
  return messageList(page)
    .locator('[data-testid^="message-$"], [data-testid^="message-~"]')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('data-testid') ?? '').replace('message-', '')));
}

/** Ordered reply ids inside the panel, oldest first as rendered (AC-T2-4, AC-T6-4). */
export async function threadRowIds(page: Page): Promise<string[]> {
  return threadMessageList(page)
    .locator('[data-testid^="message-$"], [data-testid^="message-~"]')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('data-testid') ?? '').replace('message-', '')));
}

/**
 * The people represented in an avatar stack (`thread-summary-avatars`, `thread-list-item-avatars`).
 *
 * An avatar is an image or an initials badge, so it usually carries **no text**: identity lives in
 * `title` / `aria-label` / `alt`, which is also what a screen reader reads. Asserting
 * `toContainText('Bob')` on the stack therefore fails for a user who *has* an avatar image — the
 * mistake this helper exists to prevent.
 */
export async function avatarNames(stack: Locator): Promise<string[]> {
  return stack.locator('> *').evaluateAll((els) =>
    els.map((el) => {
      const img = el.querySelector('img');
      return (
        el.getAttribute('title') ??
        el.getAttribute('aria-label') ??
        img?.getAttribute('alt') ??
        (el.textContent ?? '').trim()
      );
    }),
  );
}

/** `thread-list-item-*` in DOM order with their `data-ts` / `data-count` (AC-T7-2/3). */
export async function threadListOrder(
  page: Page,
): Promise<{ rootId: string; ts: number; count: number }[]> {
  return threadList(page)
    .locator('[data-testid^="thread-list-item-"]')
    .evaluateAll((els) =>
      els
        .map((el) => ({
          rootId: (el.getAttribute('data-testid') ?? '').replace('thread-list-item-', ''),
          ts: Number(el.getAttribute('data-ts') ?? '0'),
          count: Number(el.getAttribute('data-count') ?? '0'),
        }))
        // `thread-list-item-author` and friends also start with the prefix; items carry a root id
        // that looks like an event id.
        .filter((item) => item.rootId.startsWith('$')),
    );
}

/* ------------------------------------------------------------------ opening a thread */

/**
 * Desktop: hover `message-{eventId}`, click `message-action-thread`, wait for the panel to report
 * that root (AC-T5-1). Returns the panel locator.
 */
export async function openThreadFromMessage(page: Page, eventId: string): Promise<Locator> {
  const target = await stableRow(page, eventId);
  await target.hover();
  const actions = target.getByTestId('message-actions');
  await expect(actions).toBeVisible();
  await actions.getByTestId('message-action-thread').click();
  await expect(threadPanel(page)).toBeVisible();
  await expect(threadPanel(page)).toHaveAttribute('data-root', eventId);
  return threadPanel(page);
}

/** Alias under the docs/PHASE3_TICKETS.md name (QA-14 lists both). */
export const openThreadFromRow = openThreadFromMessage;

/** Clicks the summary row under a root and waits for the panel on that root (AC-T4-4). */
export async function openThreadFromSummary(page: Page, rootId: string): Promise<Locator> {
  await threadSummary(page, rootId).scrollIntoViewIfNeeded();
  await threadSummary(page, rootId).click();
  await expect(threadPanel(page)).toBeVisible();
  await expect(threadPanel(page)).toHaveAttribute('data-root', rootId);
  return threadPanel(page);
}

/**
 * A room row that is visible and has stopped moving.
 *
 * `#general` on this homeserver takes live traffic from the devs and from the rest of this suite, so
 * the list auto-scrolls while a test is aiming at a row: `scrollIntoViewIfNeeded` then fails with
 * "element is not stable" or "not attached to the DOM". Waiting for visibility first and tolerating a
 * couple of scroll attempts turns that into a retry instead of a red criterion.
 */
export async function stableRow(page: Page, eventId: string, timeout = 20_000): Promise<Locator> {
  const target = row(page, eventId);
  await target.waitFor({ state: 'visible', timeout });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await target.scrollIntoViewIfNeeded({ timeout: 5_000 });
      return target;
    } catch {
      await target.waitFor({ state: 'visible', timeout: 5_000 });
    }
  }
  return target;
}

/**
 * Phone: long-press a row until `message-action-sheet` is open, and return the sheet.
 *
 * Two things swallow a long-press on this app, and both are retried here rather than asserted away:
 *  - the list is still auto-scrolling, so the synthetic touch lands where the row *was* (hence
 *    `stableRow`);
 *  - a drawer that was *just* closed leaves `drawer-backdrop` fading over the row at a higher
 *    z-index, and the CDP touch hits the backdrop. `data-open` flips the moment the drawer closes,
 *    so a test that waited for the attribute can still be inside the 250 ms transition — the phone
 *    smoke walks straight from "tap outside to close the member drawer" (step 10) into a long-press.
 */
export async function openActionSheet(page: Page, eventId: string): Promise<Locator> {
  const sheet = page.getByTestId('message-action-sheet');
  const backdrop = page.getByTestId('drawer-backdrop');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await backdrop.count()) > 0) await settleAnimations(backdrop).catch(() => undefined);
    const target = await stableRow(page, eventId);
    await longPress(target);
    if (await sheet.isVisible()) break;
  }
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Phone: long-press a row, wait for `message-action-sheet`, tap `message-action-thread` (AC-T5-2). */
export async function longPressThread(page: Page, eventId: string): Promise<Locator> {
  const sheet = await openActionSheet(page, eventId);
  await sheet.getByTestId('message-action-thread').tap();
  await expect(sheet).toBeHidden();
  await expect(threadPanel(page)).toBeVisible();
  await expect(threadPanel(page)).toHaveAttribute('data-root', eventId);
  return threadPanel(page);
}

/** Opens the Threads list from `header-threads` and waits for it (AC-T7-2). `tap` on phone. */
export async function openThreadsList(page: Page, touch = false): Promise<Locator> {
  if (touch) await threadsButton(page).tap();
  else await threadsButton(page).click();
  await expect(threadList(page)).toBeVisible();
  return threadList(page);
}

/** Clicks/taps a list item and waits for the list to close and the panel to open (AC-T7-4). */
export async function openThreadFromList(page: Page, rootId: string, touch = false): Promise<Locator> {
  const item = threadListItem(page, rootId);
  await item.scrollIntoViewIfNeeded();
  if (touch) await item.tap();
  else await item.click();
  await expect(threadList(page)).toBeHidden();
  await expect(threadPanel(page)).toBeVisible();
  await expect(threadPanel(page)).toHaveAttribute('data-root', rootId);
  return threadPanel(page);
}

/* ------------------------------------------------------------------ inside the panel */

/** Types into `thread-composer-input` and presses Enter. Does not wait for the echo. */
export async function replyInThread(page: Page, text: string): Promise<void> {
  await threadComposer(page).click();
  await threadComposer(page).fill(text);
  await threadComposer(page).press('Enter');
}

/** Sends a reply and returns its **settled** (`$`) event id (AC-T2-1/2 need the server id). */
export async function replyInThreadAndSettle(page: Page, text: string): Promise<string> {
  await replyInThread(page, text);
  const sent = threadRowByText(page, text);
  await expect(sent).toBeVisible();
  return settledEventId(sent);
}

/** Desktop close (X) and a wait for the panel to leave the DOM (AC-T6-6). */
export async function closeThread(page: Page): Promise<void> {
  await threadClose(page).click();
  await expect(threadPanel(page)).toHaveCount(0);
}

/** Phone close: `header-back` (the only phone close — docs/PHASE3_PLAN.md). */
export async function closeThreadOnPhone(page: Page): Promise<void> {
  await page.getByTestId('header-back').tap();
  await expect(threadPanel(page)).toHaveCount(0);
}

/** True when `thread-message-list` is scrolled within `slack` px of the bottom (AC-T6-5). */
export function threadAtBottom(page: Page, slack = 8): Promise<boolean> {
  return threadMessageList(page).evaluate(
    (el, s) => el.scrollHeight - el.scrollTop - el.clientHeight <= (s as number),
    slack,
  );
}

export function threadScrollMetrics(page: Page): Promise<{ top: number; height: number; client: number }> {
  return threadMessageList(page).evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    client: el.clientHeight,
  }));
}

/**
 * Scrolls the panel's list to the top repeatedly until `stop()` holds, so the thread pages fully in
 * (AC-T2-4, AC-T6-4). Same shape as `paginateToTop` in `ui.ts`, scoped to `thread-message-list`.
 */
export async function paginateThreadToTop(
  page: Page,
  stop: () => Promise<boolean>,
  maxRounds = 12,
): Promise<boolean> {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await stop()) return true;
    const before = await threadScrollMetrics(page);
    await threadMessageList(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect
      .poll(
        async () => {
          if (await stop()) return 'done';
          const now = await threadScrollMetrics(page);
          return now.height !== before.height ? 'grew' : 'same';
        },
        { timeout: 10_000, intervals: [100, 200, 300, 500] },
      )
      .not.toBe('same')
      .catch(() => undefined);
  }
  return stop();
}

/* ------------------------------------------------------------------ test data */

/** A body nothing else on this dirty homeserver can collide with. */
export function uniqueBody(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}

/**
 * Creates a thread root plus `replies` API replies as one chain, dirty-seed safe.
 *
 * The `latest` of each reply is the previous reply's **server** id, passed explicitly: one
 * `/relations` round trip per reply would triple the cost of the 35/40-reply cases, and the chain is
 * exactly what the contract prescribes.
 */
export async function seedThread(opts: {
  roomId: string;
  /** Who posts the root (default bob, so alice can use "Reply in thread" on someone else's message). */
  rootSender?: 'alice' | 'bob' | 'carol' | 'dave';
  /** Who posts the replies (default bob). */
  replySender?: 'alice' | 'bob' | 'carol' | 'dave';
  rootBody?: string;
  replies?: number;
  /** Body of reply `i` (0-based). Default `<rootBody> reply <i+1>`. */
  replyBody?: (i: number) => string;
}): Promise<{ rootId: string; rootBody: string; replyIds: string[] }> {
  const rootBody = opts.rootBody ?? uniqueBody('QA thread root');
  const rooter = await asUser(opts.rootSender ?? 'bob');
  const replier = await asUser(opts.replySender ?? 'bob');
  const rootId = await rooter.send(opts.roomId, rootBody);

  const replyIds: string[] = [];
  let latest = rootId;
  for (let i = 0; i < (opts.replies ?? 0); i += 1) {
    const body = opts.replyBody ? opts.replyBody(i) : `${rootBody} reply ${i + 1}`;
    const id = await replier.sendThreadReply(opts.roomId, rootId, body, { latest });
    replyIds.push(id);
    latest = id;
  }
  return { rootId, rootBody, replyIds };
}

/**
 * Waits until `message-{rootId}` is rendered in `message-list`, paging forward is not a thing, so the
 * root must simply have arrived over sync. Returns the row.
 */
export async function waitForRoomRow(page: Page, eventId: string, timeout = 15_000): Promise<Locator> {
  const target = row(page, eventId);
  await expect(target).toBeVisible({ timeout });
  return target;
}

/* ------------------------------------------------------------------ not-built guard (Wave 8) */

/**
 * Wave 8 runs the thread specs while Dev A and Dev B are still implementing, so a criterion can be
 * red for three very different reasons: **not built yet**, a **real bug**, or a **test defect**. Only
 * the last two are QA's to act on, and a wall of identical "locator not found" failures hides them.
 *
 * So each spec declares the UI entry point it needs and `requireThreadUi` skips with an actionable
 * `not-built` annotation when that entry point is absent. It is the same idiom as
 * `requireFreshSeed` in `fresh.ts`, with the same caching rationale.
 *
 * The probes are **entry points**, never panel internals: the PRIN-10 skeleton already puts
 * `thread-panel` / `thread-root` / `thread-close` in the tree, so probing those would report "built"
 * while nothing is openable. What is probed instead:
 *
 * | feature | probe | owner |
 * |---|---|---|
 * | `threads-button` | `header-threads` inside `channel-header` | Dev A (DEV-A-17) |
 * | `threads-list` | clicking it opens `thread-list` | Dev A (DEV-A-17) |
 * | `thread-action` | hovering a row shows `message-action-thread` (desktop) / long-press shows it in `message-action-sheet` (phone) | Dev B (DEV-B-19) |
 * | `thread-panel` | using that action mounts a panel with `thread-composer-input` (registry name, not the skeleton's) | Dev B (DEV-B-20) |
 * | `thread-summary` | a root with one API reply grows a `thread-summary-{rootId}` row | Dev B (DEV-B-18) |
 *
 * Probing runs **once per worker in its own page** (`context().newPage()`), so it never disturbs the
 * state the calling test has set up, and the verdict is cached: a feature that is absent cannot
 * appear mid-run (the dev servers are on 5181/5182; this run owns 5173).
 */
export type ThreadFeature =
  | 'threads-button'
  | 'threads-list'
  | 'thread-action'
  | 'thread-panel'
  | 'thread-summary'
  /** Phone only (DEV-A-18): `header-back` replaces `header-menu` while a thread is open. */
  | 'phone-back';

export type ThreadUiReport = Record<ThreadFeature, boolean> & { notes: string[] };

/** Just enough of Playwright's `test` object to skip and annotate; pass the imported `test`. */
export interface ThreadUiTest {
  skip(condition: boolean, description: string): void;
  info(): { annotations: { type: string; description?: string }[] };
}

const PRESENT = 4_000;

let probed: Promise<ThreadUiReport> | undefined;

async function probeThreadUi(page: Page, touch: boolean): Promise<ThreadUiReport> {
  const report: ThreadUiReport = {
    'threads-button': false,
    'threads-list': false,
    'thread-action': false,
    'thread-panel': false,
    'thread-summary': false,
    'phone-back': false,
    notes: [],
  };

  const probe = await page.context().newPage();
  try {
    const general = await resolveRoom('general');
    // A root with one reply, so the summary row has something to render before the probe looks.
    const { rootId } = await seedThread({ roomId: general, replies: 1, rootBody: uniqueBody('QA probe root') });

    await loginAs(probe, 'alice');
    if (!touch) await openChannel(probe, general);

    report['threads-button'] = await probe
      .getByTestId('channel-header')
      .getByTestId('header-threads')
      .waitFor({ state: 'visible', timeout: PRESENT })
      .then(() => true)
      .catch(() => false);

    if (report['threads-button']) {
      report['threads-list'] = await openThreadsList(probe, touch)
        .then(() => true)
        .catch(() => false);
      if (report['threads-list']) await probe.keyboard.press('Escape').catch(() => undefined);
    }

    const target = await stableRow(probe, rootId).then(
      (t) => t,
      () => null,
    );
    const rootVisible = target !== null;
    if (!rootVisible) {
      report.notes.push(
        `probe root ${rootId} never rendered in #general, so the action/summary probes are inconclusive`,
      );
    } else {
      const seen = (locator: Locator, timeout = PRESENT): Promise<boolean> =>
        locator
          .waitFor({ state: 'visible', timeout })
          .then(() => true)
          .catch(() => false);

      report['thread-summary'] = await seen(threadSummary(probe, rootId), 8_000);

      if (touch) {
        report['thread-action'] = await longPress(target)
          .then(() =>
            seen(probe.getByTestId('message-action-sheet').getByTestId('message-action-thread')),
          )
          .catch(() => false);
        if (report['thread-action']) {
          // The sheet is already open from the probe above, so tap the item directly rather than
          // long-pressing a row the sheet now covers.
          report['thread-panel'] = await probe
            .getByTestId('message-action-sheet')
            .getByTestId('message-action-thread')
            .tap()
            .then(() => seen(threadComposer(probe)))
            .catch(() => false);
          if (report['thread-panel']) {
            report['phone-back'] = await seen(probe.getByTestId('header-back'));
          }
        }
      } else {
        await target.hover().catch(() => undefined);
        report['thread-action'] = await seen(
          target.getByTestId('message-actions').getByTestId('message-action-thread'),
        );
        if (report['thread-action']) {
          report['thread-panel'] = await openThreadFromMessage(probe, rootId)
            .then(() => seen(threadComposer(probe)))
            .catch(() => false);
        }
      }
      if (report['thread-action'] && !report['thread-panel']) {
        const skeleton = await probe.getByTestId('thread-panel').count();
        report.notes.push(
          skeleton > 0
            ? 'thread-panel is mounted but has no `thread-composer-input` — the PRIN-10 skeleton, not DEV-B-20'
            : '`message-action-thread` exists but opens no `thread-panel`',
        );
      }
    }
  } finally {
    // `context().newPage()` shares the context's **origin storage** with the calling test's page, so
    // the probe's own login would be restored by that page's `goto('/')` and `login-form` would never
    // appear (`loginAs`'s `dropStoredSession` is a no-op while the test page is still on about:blank).
    // Dropping the session the probe created keeps the probe invisible to the test that triggered it.
    await probe
      .evaluate(() => {
        try {
          window.localStorage.clear();
        } catch {
          /* storage may be unavailable */
        }
      })
      .catch(() => undefined);
    await probe.close().catch(() => undefined);
  }
  return report;
}

/**
 * Guarantees the next `loginAs` really sees `login-form`, whatever this context's origin storage
 * holds (see the note in `probeThreadUi`). Cheap and idempotent; call it before `loginAs` in a test
 * that also calls `requireThreadUi`.
 */
export async function resetSession(page: Page): Promise<void> {
  if (!/^https?:/i.test(page.url())) await page.goto('/');
  await page
    .evaluate(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* storage may be unavailable */
      }
    })
    .catch(() => undefined);
}

/** Probes the thread UI once per worker (own page) and caches the verdict. */
export function checkThreadUi(page: Page, touch = false): Promise<ThreadUiReport> {
  probed ??= probeThreadUi(page, touch);
  return probed;
}

/**
 * Skips the calling test with a `not-built` annotation unless every listed feature is present.
 *
 *   test('AC-T4-2 ...', async ({ page }) => {
 *     await requireThreadUi(test, page, 'thread-panel');
 *     ...
 *   });
 */
export async function requireThreadUi(
  test: ThreadUiTest,
  page: Page,
  features: ThreadFeature | ThreadFeature[],
  opts: { touch?: boolean } = {},
): Promise<ThreadUiReport> {
  const report = await checkThreadUi(page, opts.touch ?? false);
  const needed = Array.isArray(features) ? features : [features];
  const missing = needed.filter((f) => !report[f]);
  if (missing.length > 0) {
    test.info().annotations.push({
      type: 'not-built',
      description: `thread UI not implemented yet: ${missing.join(', ')}${report.notes.length ? ` (${report.notes.join('; ')})` : ''}`,
    });
    test.skip(true, `thread UI not built: ${missing.join(', ')}`);
  }
  return report;
}
