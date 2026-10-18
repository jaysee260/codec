/**
 * QA-32: phone link preview suite (Pixel 7, `mobile` project): AC-L4-5, AC-L3-1/2, AC-L5-1 (docs/PHASE6_ACCEPTANCE.md).
 *
 * Same contract as link-preview.spec.ts: #dev / #vault only, unique `?t=` fixture URLs, real Synapse round trip
 * (the test Synapse whitelists loopback and fetches public/preview-fixtures/ from the page's own Vite), the
 * no-third-party guard and the preview request listener installed before the first navigation. Taps, not clicks.
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { resolveRoom } from './fixtures/seed.ts';
import { messageList, row, rowByText, settledEventId } from './fixtures/ui.ts';
import { expectTapTarget, isPhoneLayout, tapRoom } from './fixtures/mobile.ts';
import { requireUi, waitForStatus } from './fixtures/e2ee.ts';
import {
  FIXTURES,
  cardFor,
  cards,
  clearHidden,
  expectReady,
  fixtureUrl,
  hiddenStore,
  noThirdParty,
  previewRequests,
  previewsHost,
  sleep,
  uniq,
  type PreviewRequests,
  type ThirdPartyGuard,
} from './fixtures/link-preview.ts';

test.describe.configure({ mode: 'parallel', timeout: 90_000 });

const R = { dev: '', vault: '', acme: '' };
const CARD_UI = ['link-preview', 'link-previews', 'link-preview-title', 'link-preview-hide'] as const;

test.beforeAll(async () => {
  R.dev = await resolveRoom('dev');
  R.vault = await resolveRoom('vault');
  R.acme = await resolveRoom('acme-hq');
});

async function startPhone(page: Page, roomId: string, opts: { encrypted?: boolean } = {}): Promise<{ guard: ThirdPartyGuard; reqs: PreviewRequests }> {
  const guard = await noThirdParty(page);
  const reqs = previewRequests(page);
  // Straight into the room (the default #general holds a seeded link that would be previewed, legitimately).
  await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId } });
  expect(await isPhoneLayout(page), 'this spec only runs in the mobile project').toBe(true);
  if (opts.encrypted) await waitForStatus(page);
  await tapRoom(page, roomId);
  await expect(messageList(page)).toBeVisible();
  return { guard, reqs };
}

/** Types into the composer and sends with the send button (tap), returns the settled event id. */
async function send(page: Page, text: string, marker: string): Promise<string> {
  const input = page.getByTestId('composer-input');
  await input.tap();
  await input.fill(text);
  await page.getByTestId('composer-send').tap();
  return settledEventId(rowByText(page, marker), 20_000);
}

test('AC-L4-5 phone: the card is full width, no horizontal scroll, 44 px hide, tappable title', async ({ page }) => {
  requireUi('Dev A', ...CARD_UI);
  const { guard } = await startPhone(page, R.dev);
  const marker = uniq('M45');
  const url = fixtureUrl(page, 'article.html', `t=${marker}`);
  const id = await send(page, `${url} ${marker}`, marker);
  const r = row(page, id);
  const card = await expectReady(r, url, 15_000);
  const cardBox = (await card.boundingBox())!;
  const bodyBox = (await r.getByTestId('message-body').boundingBox())!;
  const hostBox = (await previewsHost(r).boundingBox())!;
  // The available width is the message content column: the body's own width can shrink to its text, so take the
  // wider of the body and the host as the column.
  const column = Math.max(bodyBox.width, hostBox.width);
  expect(Math.abs(cardBox.width - column), `card ${cardBox.width}px vs column ${column}px`).toBeLessThanOrEqual(2);
  const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(scroll.sw, 'no horizontal page scroll').toBeLessThanOrEqual(scroll.iw);
  await expectTapTarget(card.getByTestId('link-preview-hide'), 'link-preview-hide');
  const title = card.getByTestId('link-preview-title');
  await expect(title).toHaveText(FIXTURES.article.title);
  // Tappable: tapping opens the page in a new tab (target=_blank).
  const popup = page.context().waitForEvent('page', { timeout: 10_000 });
  await title.tap();
  const tab = await popup;
  expect(tab.url()).toContain('/preview-fixtures/article.html');
  await tab.close();
  expect(guard.violations()).toEqual([]);
});

test('AC-L3-1 + AC-L3-2 phone #vault: Show preview (44 px), zero requests until the tap, then the card', async ({ page }) => {
  requireUi('Dev A', ...CARD_UI, 'link-preview-load');
  const { reqs, guard } = await startPhone(page, R.vault, { encrypted: true });
  const marker = uniq('M31');
  const url = fixtureUrl(page, 'article.html', `t=${marker}`);
  const id = await send(page, `${url} ${marker}`, marker);
  const card = cardFor(row(page, id), url);
  await expect(card).toHaveAttribute('data-state', 'click-to-load', { timeout: 10_000 });
  await sleep(3_000);
  expect(reqs.count(), 'zero preview requests before the tap (S1)').toBe(0);
  const load = card.getByTestId('link-preview-load');
  await expect(load).toContainText('Show preview');
  await expectTapTarget(load, 'link-preview-load');
  await load.tap();
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await expect(card.getByTestId('link-preview-title')).toHaveText(FIXTURES.article.title);
  expect(reqs.urls()).toEqual([url]);
  expect(guard.violations()).toEqual([]);
});

test('AC-L5-1 phone: tap the x, the card goes, the store remembers it across a reload', async ({ page }) => {
  requireUi('Dev A', ...CARD_UI);
  await startPhone(page, R.dev);
  await clearHidden(page);
  const marker = uniq('M51');
  const url = fixtureUrl(page, 'square.html', `t=${marker}`);
  const id = await send(page, `${url} ${marker}`, marker);
  const r = row(page, id);
  await expectReady(r, url, 15_000);
  await cardFor(r, url).getByTestId('link-preview-hide').tap();
  await expect(cards(r)).toHaveCount(0);
  await expect(previewsHost(r)).toHaveCount(0);
  expect(await hiddenStore(page)).toContain(`${id}|${url}`);
  await page.reload();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await expect(messageList(page)).toBeVisible({ timeout: 30_000 });
  if ((await row(page, id).count()) === 0) await tapRoom(page, R.dev);
  await expect(row(page, id).getByTestId('message-body')).toContainText(marker, { timeout: 15_000 });
  await expect(cards(row(page, id))).toHaveCount(0);
});
