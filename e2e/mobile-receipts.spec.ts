/**
 * QA-R3: read receipts, phone (Pixel 7; docs/archive/RECEIPTS_ACCEPTANCE.md AC-R5, AC-R7-1, AC-R8-2). Desktop half:
 * receipts.spec.ts. Same contract: readers via the API (fixtures/receipts.ts), 15 s polls, a fresh message per
 * test in #dev, tap (never click), `settleAnimations` before geometry. Listed in both regexes of
 * playwright.config.ts like mobile-link-preview, so it runs in `mobile` only.
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { resolveRoom, userId } from './fixtures/seed.ts';
import { messageList } from './fixtures/ui.ts';
import { e2eeAfterEach, requireUi } from './fixtures/e2ee.ts';
import { markRoomRead } from './fixtures/state.ts';
import { expectTapTarget, isPhoneLayout, openNavDrawer, settleAnimations, tapRoom } from './fixtures/mobile.ts';
import { openActionSheet } from './fixtures/threads.ts';
import {
  RECEIPT_TIMEOUT,
  SETTINGS_KEY,
  SETTINGS_TYPE,
  UI,
  appSetting,
  expectReadersAt,
  listIds,
  mainRow,
  putAccountData,
  readAs,
  receiptAvatars,
  receiptList,
  receiptToggle,
  snapshotSettings,
  uniq,
  waitForReceiptsHook,
} from './fixtures/receipts.ts';

test.describe.configure({ mode: 'parallel', timeout: 90_000 });

const R = { dev: '', acme: '' };
const B = userId('bob');
const C = userId('carol');
const D = userId('dave');
let alice: ApiUser;

test.beforeAll(async () => {
  R.dev = await resolveRoom('dev');
  R.acme = await resolveRoom('acme-hq');
  alice = await asUser('alice');
});

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
  await markRoomRead(R.dev).catch(() => undefined);
});

async function startPhone(page: Page): Promise<void> {
  await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.dev } });
  expect(await isPhoneLayout(page), 'this spec only runs in the mobile project').toBe(true);
  await waitForReceiptsHook(page);
  await tapRoom(page, R.dev);
  await expect(messageList(page)).toBeVisible();
}

async function sendApi(page: Page, text: string): Promise<string> {
  const id = await alice.send(R.dev, text);
  await expect(mainRow(page, id)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
  return id;
}

test('AC-R5-1 + AC-R5-3 tap the avatars: a bottom sheet with a backdrop; 44 px targets; no horizontal scroll', async ({ page }) => {
  requireUi('Dev A', ...UI.avatars, ...UI.list, ...UI.backdrop);
  await startPhone(page);
  const a7 = await sendApi(page, uniq('M51 A7'));
  await readAs('bob', R.dev, a7);
  await expectReadersAt(page, R.dev, a7, [B]);
  const strip = receiptAvatars(mainRow(page, a7));
  await expect(strip).toBeVisible({ timeout: RECEIPT_TIMEOUT });
  // AC-R5-3 asks for 44 px *tall* (the strip's width follows its avatar count).
  expect(Math.round((await strip.boundingBox())!.height), 'receipt-avatars >= 44 px tall').toBeGreaterThanOrEqual(44);
  await strip.tap();
  const sheet = receiptList(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-mode', 'sheet');
  await expect(sheet).toHaveAttribute('data-event-id', a7);
  await expect(sheet).toHaveAttribute('role', 'dialog');
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await settleAnimations(sheet);
  const items = sheet.getByTestId('receipt-list-item');
  for (let i = 0; i < (await items.count()); i += 1) expect(Math.round((await items.nth(i).boundingBox())!.height), `receipt-list-item ${i} >= 44 px tall`).toBeGreaterThanOrEqual(44);
  const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(scroll.sw, 'no horizontal page scroll').toBeLessThanOrEqual(scroll.iw);
  const backdrop = page.getByTestId('receipt-list-backdrop');
  await expect(backdrop).toBeVisible();
  // The sheet covers the bottom of the backdrop: tap its exposed top strip.
  await backdrop.tap({ position: { x: 20, y: 20 } });
  await expect(sheet).toHaveCount(0);
});

test('AC-R5-2 long-press a row nobody read: Seen by in the action sheet opens the sheet with bob, carol, dave unseen', async ({ page }) => {
  requireUi('Dev B', ...UI.seenByAction, ...UI.list);
  await startPhone(page);
  const id = await sendApi(page, uniq('M52 quiet'));
  const actions = await openActionSheet(page, id);
  const seenBy = actions.getByTestId('message-action-seen-by');
  await expect(seenBy).toBeVisible();
  await seenBy.tap();
  await expect(page.getByTestId('message-action-sheet')).toHaveCount(0);
  const sheet = receiptList(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-mode', 'sheet');
  await expect(sheet).toHaveAttribute('data-event-id', id);
  await expect(sheet.getByTestId('receipt-list-unseen')).toBeVisible();
  await expect.poll(async () => (await listIds(page, 'unseen')).sort(), { timeout: RECEIPT_TIMEOUT }).toEqual([B, C, D].sort());
});

test('AC-R5-3 + AC-R7-1 phone: the toggle is reachable from the drawer footer, 44 px, default ON', async ({ page }) => {
  requireUi('Dev A', ...UI.toggle);
  const settings = await snapshotSettings('alice');
  try {
    const { [SETTINGS_KEY]: _drop, ...rest } = settings.before ?? {};
    await putAccountData('alice', SETTINGS_TYPE, rest);
    await startPhone(page);
    expect(await appSetting(page)).toBe(true);
    await openNavDrawer(page);
    const t = receiptToggle(page);
    await expect(t).toBeVisible();
    await settleAnimations(page.getByTestId('nav-drawer'));
    await expectTapTarget(t, 'settings-send-read-receipts');
    await expect(t).toHaveAttribute('aria-checked', 'true');
    await expect(t).toContainText('Send read receipts');
  } finally {
    await settings.restore();
  }
});

test('AC-R8-2 phone: Escape closes the sheet and returns focus to the avatars', async ({ page }) => {
  requireUi('Dev A', ...UI.avatars, ...UI.list);
  await startPhone(page);
  const id = await sendApi(page, uniq('M82'));
  await readAs('carol', R.dev, id);
  const strip = receiptAvatars(mainRow(page, id));
  await expect(strip).toBeVisible({ timeout: RECEIPT_TIMEOUT });
  await strip.focus();
  await page.keyboard.press('Enter');
  const sheet = receiptList(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-mode', 'sheet');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(strip).toBeFocused();
});
