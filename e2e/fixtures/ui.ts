/**
 * UI helpers shared by the specs. Everything here is built from the `data-testid` registry in
 * docs/ACCEPTANCE.md — no CSS or text selectors for structure (text is only ever asserted on,
 * or used to find *unseeded* messages, which the contract explicitly allows).
 *
 * Rules kept here so the specs stay readable:
 *  - no `waitForTimeout`: waits are locator auto-waits, `expect.poll` or testid waits;
 *  - seeded messages are located by event id, new ones by text inside `message-list`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEMO_SHOT_DIR = resolve(HERE, '../results/demo');

/* ------------------------------------------------------------------ locators */

export const row = (page: Page, eventId: string): Locator => page.getByTestId(`message-${eventId}`);
export const messageList = (page: Page): Locator => page.getByTestId('message-list');
export const composer = (page: Page): Locator => page.getByTestId('composer-input');
export const channelItem = (page: Page, roomId: string): Locator => page.getByTestId(`channel-item-${roomId}`);
export const dmItem = (page: Page, roomId: string): Locator => page.getByTestId(`dm-item-${roomId}`);
export const spaceItem = (page: Page, spaceId: string): Locator => page.getByTestId(`space-item-${spaceId}`);
export const memberItem = (page: Page, userId: string): Locator => page.getByTestId(`member-item-${userId}`);

/**
 * A message row found by its text (for messages this run created, which have no seeded id).
 * Matches both settled (`$...`) and local-echo (`~...`) event ids.
 */
export const rowByText = (page: Page, text: string): Locator =>
  messageList(page).getByTestId(/^message-[$~]/).filter({ hasText: text });

/** Named list item by the `data-name` helper attribute (docs/ACCEPTANCE.md test-id conventions 4). */
export const byName = (scope: Locator, name: string): Locator => scope.locator(`[data-name="${name}"]`);

/**
 * `data-name` of each item in a list, in DOM order. Scoped by testid prefix so decorations that
 * also carry `data-name` (the rail's Home and "Add a space" buttons) are not counted as items.
 */
export async function itemNames(scope: Locator, testIdPrefix: string): Promise<(string | undefined)[]> {
  return scope
    .locator(`[data-testid^="${testIdPrefix}"][data-name]`)
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.name));
}

/** Ordered `data-testid`s of the rail's space items, e.g. `['space-item-home', 'space-item-!acme...']`. */
export async function railOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId('space-rail')
    .locator('[data-testid^="space-item-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
}

/* ------------------------------------------------------------------ navigation */

/** Clicks a space in the rail and waits for it to report itself selected. */
export async function openSpace(page: Page, spaceId: string): Promise<void> {
  await spaceItem(page, spaceId).click();
  await expect(spaceItem(page, spaceId)).toHaveAttribute('data-selected', 'true');
}

/** Clicks Home (the DM view) and waits for the DM list. */
export async function openHome(page: Page): Promise<void> {
  await page.getByTestId('space-item-home').click();
  await expect(page.getByTestId('dm-list')).toBeVisible();
}

/** Clicks a channel and waits until the conversation for it is mounted. */
export async function openChannel(page: Page, roomId: string): Promise<void> {
  await channelItem(page, roomId).click();
  await expect(channelItem(page, roomId)).toHaveAttribute('data-selected', 'true');
  await expect(messageList(page)).toBeVisible();
}

/** Clicks a DM (Home must already be selected) and waits for the conversation. */
export async function openDm(page: Page, roomId: string): Promise<void> {
  await dmItem(page, roomId).click();
  await expect(messageList(page)).toBeVisible();
}

/* ------------------------------------------------------------------ conversation */

/** Types `text` into the composer and presses Enter. Does not wait for the echo. */
export async function typeAndSend(page: Page, text: string): Promise<void> {
  await composer(page).click();
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** Hovers a message row so its `message-actions` toolbar appears, then returns the toolbar. */
export async function hoverActions(page: Page, eventId: string): Promise<Locator> {
  const target = row(page, eventId);
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  const actions = target.getByTestId('message-actions');
  await expect(actions).toBeVisible();
  return actions;
}

/** True when `message-list` is scrolled within `slack` px of the bottom. */
export function atBottom(page: Page, slack = 8): Promise<boolean> {
  return messageList(page).evaluate(
    (el, s) => el.scrollHeight - el.scrollTop - el.clientHeight <= (s as number),
    slack,
  );
}

export function scrollMetrics(page: Page): Promise<{ top: number; height: number; client: number }> {
  return messageList(page).evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    client: el.clientHeight,
  }));
}

/** Scrolls `message-list` to the very top (one jump; pagination is driven by the app's sentinel). */
export async function scrollListToTop(page: Page): Promise<void> {
  await messageList(page).evaluate((el) => {
    el.scrollTop = 0;
  });
}

/** Scrolls `message-list` to the bottom. */
export async function scrollListToBottom(page: Page): Promise<void> {
  await messageList(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

/**
 * Scrolls to the top repeatedly until `stop()` is true or `maxRounds` is spent, so backwards
 * pagination can walk a whole room. Each round waits for the list's scrollHeight to settle.
 */
export async function paginateToTop(
  page: Page,
  stop: () => Promise<boolean>,
  maxRounds = 12,
): Promise<boolean> {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await stop()) return true;
    const before = await scrollMetrics(page);
    await scrollListToTop(page);
    // Either the list grew (more history arrived) or we are at the start banner.
    await expect
      .poll(
        async () => {
          if (await stop()) return 'done';
          const now = await scrollMetrics(page);
          return now.height !== before.height ? 'grew' : 'same';
        },
        { timeout: 10_000, intervals: [100, 200, 300, 500] },
      )
      .not.toBe('same')
      .catch(() => undefined);
  }
  return stop();
}

/** The `data-count` of a badge as a number, or null when the badge is absent. */
export async function badgeCount(locator: Locator): Promise<number | null> {
  if ((await locator.count()) === 0) return null;
  const raw = await locator.first().getAttribute('data-count');
  return raw === null ? null : Number(raw);
}

/* ------------------------------------------------------------------ screenshots */

/**
 * Full-page screenshot for the demo walk-through (QA-3): written on success as well as failure,
 * because the set is the stakeholder pre-read.
 */
export async function stepShot(page: Page, step: number, slug: string): Promise<string> {
  mkdirSync(DEMO_SHOT_DIR, { recursive: true });
  const file = resolve(DEMO_SHOT_DIR, `${String(step).padStart(2, '0')}-${slug}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
