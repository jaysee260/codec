/**
 * Phase 7 QA-36: calls in rooms (desktop). docs/PHASE7_ACCEPTANCE.md AC-R3-1/2 (through the UI), AC-R4-3, AC-R4-6
 * (P1), AC-R6-6, AC-R6-7 (P1, the "No call keys" tile), AC-R8-1/2/4.
 *
 * Rooms: `#vault` (alice, bob, dave; encrypted; seeded with the public preset, so `grantCallPowerLevels` gives the
 * call event types PL 0 through the API as alice first), the 7-member drop-in room (created per run via API: alice,
 * bob, carol, dave + three throwaway users, in Acme HQ), and for the P1 bridge rows a `@signal_*` ghost DM / group.
 * The 3-person test uses dave as the third person (carol is not in #vault) and opens the third context last,
 * closing it in the same test (AC-R10-1 exception).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { DISPLAY_NAMES, HS_URL, resolveRoom, uniqueName, userId } from './fixtures/seed.ts';
import { asUser } from './fixtures/matrix-api.ts';
import { createRoom, freshUser, joinRoom, sendStateEvent } from './fixtures/e2ee-api.ts';
import { e2eeAfterEach, loginWith, requireUi, secondContext, waitForStatus, type SecondContext } from './fixtures/e2ee.ts';
import { channelItem, dmItem, openChannel, openDm, openHome, openSpace } from './fixtures/ui.ts';
import {
  LINE_TYPE,
  RING_TYPE,
  blockMediaKeys,
  callAllowed,
  callEventsSince,
  callHook,
  callScreen,
  cleanupCalls,
  connectedWith,
  grantCallPowerLevels,
  incomingCard,
  participantTile,
  remoteOf,
  requireRtc,
  waitForCallState,
} from './fixtures/call.ts';

test.describe.configure({ mode: 'default', timeout: 150_000 }); // one worker, file order (fullyParallel: false); a failure does not skip the rest

const ALICE = userId('alice');
const BOB = userId('bob');
const DAVE = userId('dave');
const R = { dm: '', vault: '', general: '', acme: '', big: '' };
const contexts: SecondContext[] = [];

test.beforeAll(async () => {
  R.dm = await resolveRoom('dm-alice-dave');
  R.vault = await resolveRoom('vault');
  R.general = await resolveRoom('general');
  R.acme = await resolveRoom('acme-hq');
  await grantCallPowerLevels(R.vault);
});

test.beforeEach(async () => {
  await requireRtc(test);
  await cleanupCalls([R.dm, R.vault, ...(R.big ? [R.big] : [])]);
});

test.afterEach(async ({ page }, info) => {
  await cleanupCalls([R.dm, R.vault, ...(R.big ? [R.big] : [])], [page, ...contexts.map((c) => c.page)]);
  contexts.length = 0;
  await e2eeAfterEach(page, info);
});

async function asAlice(page: Page): Promise<void> {
  await loginWith(page, 'alice');
  await waitForStatus(page);
}

async function other(browser: Browser, user: 'bob' | 'dave' | 'carol' | 'alice'): Promise<SecondContext> {
  const c = await secondContext(browser, user);
  contexts.push(c);
  await waitForStatus(c.page);
  return c;
}

async function openRoom(page: Page, roomId: string): Promise<void> {
  await openSpace(page, R.acme);
  await openChannel(page, roomId);
}

/** The 7-member encrypted room for the drop-in rule (alice + 6 others), in Acme HQ, call power levels granted. */
async function bigRoom(): Promise<string> {
  if (R.big) return R.big;
  const alice = await asUser('alice');
  const extras = await Promise.all([freshUser('qacall'), freshUser('qacall'), freshUser('qacall')]);
  const roomId = await createRoom(alice.token, {
    name: uniqueName('qa-call-big'),
    encrypted: true,
    preset: 'private_chat',
    spaceId: R.acme,
    invite: [BOB, userId('carol'), DAVE, ...extras.map((u) => u.userId)],
  });
  for (const key of ['bob', 'carol', 'dave'] as const) await (await asUser(key)).joinRoom(roomId);
  for (const u of extras) await joinRoom(u.token, roomId);
  await grantCallPowerLevels(roomId);
  R.big = roomId;
  return roomId;
}

// ------------------------------------------------------------------------------------------------ AC-R3-1 / R3-2 / R4-3

test('AC-R3-1: canCall is allowed in the DM and #vault, refused (unencrypted) in #general', async ({ page }) => {
  await asAlice(page);
  const hook = callHook(page);
  expect(callAllowed(await hook.canCall(R.dm))).toBe(true);
  expect(callAllowed(await hook.canCall(R.vault))).toBe(true);
  expect(await hook.canCall(R.general)).toMatchObject({ reason: 'unencrypted' });
  expect(callAllowed(await hook.canCall(R.general))).toBe(false);
});

test('AC-R3-2, R4-3: #vault (3 members) rings; a 7-member room is drop-in: connected alone, nobody rung, bob sees "Join voice (1)"', async ({ page, browser }) => {
  requireUi('Dev B', 'header-call', 'call-screen');
  requireUi('Dev A', 'header-join-call');
  const big = await bigRoom();
  await asAlice(page);
  await openRoom(page, R.vault);
  await expect(page.getByTestId('header-call')).toHaveAttribute('data-mode', 'ring');

  const bob = await other(browser, 'bob');
  await openChannel(page, big);
  await expect(page.getByTestId('header-call')).toHaveAttribute('data-mode', 'drop-in');
  const t0 = Date.now();
  await page.getByTestId('header-call').click();
  await expect(callScreen(page)).toBeVisible();
  // `connecting` may be shorter than one poll: accept either on the way to `connected`.
  await expect(callScreen(page)).toHaveAttribute('data-state', /connecting|connected/);
  await expect(callScreen(page)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
  await expect(page.getByTestId('call-screen').locator('[data-testid^="call-participant-@"]')).toHaveCount(1);

  // bob: the chip with one person, never a card. The chip is the sentinel that the call reached his client.
  await openRoom(bob.page, big);
  const chip = bob.page.getByTestId('header-join-call');
  await expect(chip).toHaveAttribute('data-count', '1', { timeout: 15_000 });
  await expect(incomingCard(bob.page)).toHaveCount(0);
  expect((await callHook(bob.page).state()).incoming).toEqual([]);
  // No ring event with notification_type "ring" (drop-in rings nobody; a "notification" type is allowed by AC-R3-2).
  const rings = await callEventsSince(page, big, t0, RING_TYPE);
  expect(rings.filter((e) => e.content.notification_type === 'ring')).toEqual([]);
  if (rings.length === 0) test.info().annotations.push({ type: 'contract', description: 'drop-in sends no rtc.notification at all (ARCHITECTURE Phase 7: ring:false = quiet join); AC-R3-2 allows "notification"' });
  await page.getByTestId('call-leave').click();
  await expect(chip).toHaveCount(0, { timeout: 15_000 });
});

// ------------------------------------------------------------------------------------------------ AC-R8-1 / R8-2 / R8-4

test('AC-R8-1/2/4: bob in a #vault call -> alice sees "Join voice (1)" + sidebar indicator; the chip joins; indicators clear on the last leave; DM row too', async ({ page, browser }) => {
  requireUi('Dev A', 'header-join-call', 'room-call-indicator');
  requireUi('Dev B', 'call-screen');
  await asAlice(page);
  const bob = await other(browser, 'bob');
  await openRoom(page, R.vault);
  await callHook(bob.page).join(R.vault);
  await waitForCallState(bob.page, (s) => s.activeCall?.state === 'connected', 'bob alone in the #vault call', 30_000);

  const chip = page.getByTestId('header-join-call');
  await expect(chip).toHaveAttribute('data-count', '1', { timeout: 15_000 });
  await expect(chip).toContainText('Join voice (1)');
  await expect(chip).toHaveAttribute('title', new RegExp(DISPLAY_NAMES.bob));
  await expect(page.getByTestId('header-call')).toHaveCount(0);
  const indicator = channelItem(page, R.vault).getByTestId('room-call-indicator');
  await expect(indicator).toHaveAttribute('data-count', '1');
  await expect(indicator).toHaveAttribute('aria-label', '1 in voice');
  const green = await chip.evaluate((el) => getComputedStyle(el.querySelector('span') ?? el).backgroundColor);
  test.info().annotations.push({ type: 'style', description: `chip background ${green} (AC: green)` });

  await chip.click();
  await expect(callScreen(page)).toHaveAttribute('data-state', /connecting|connected/);
  await expect(callScreen(page)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
  await waitForCallState(page, connectedWith(BOB), 'alice joined bob, key ok', 30_000);
  await expect(chip, 'in the call: the chip is hidden').toHaveCount(0);
  await expect(indicator).toHaveAttribute('data-count', '2', { timeout: 10_000 });
  await page.getByTestId('call-minimise').click();
  await expect(page.getByTestId('in-call-bar')).toBeVisible();

  // Last leave -> the indicator goes within 5 s.
  await callHook(bob.page).leave();
  await page.getByTestId('in-call-bar-leave').click();
  const tGone = Date.now();
  await expect(indicator).toHaveCount(0, { timeout: 8_000 });
  test.info().annotations.push({ type: 'timing', description: `last leave -> indicator gone ${Date.now() - tGone} ms (AC: 5 s)` });

  // DM row: dave in a quiet DM call -> alice's DM row shows the indicator.
  const dave = await other(browser, 'dave');
  await callHook(dave.page).join(R.dm);
  await openHome(page);
  await expect(dmItem(page, R.dm).getByTestId('room-call-indicator')).toHaveAttribute('data-count', '1', { timeout: 15_000 });
  await callHook(dave.page).leave();
  await expect(dmItem(page, R.dm).getByTestId('room-call-indicator')).toHaveCount(0, { timeout: 8_000 });
});

// ------------------------------------------------------------------------------------------------ AC-R6-6

test('AC-R6-6: 3-person #vault call: bob leaves -> alice stays connected with 2 tiles, no line; alice leaves; dave (last) sends ended', async ({ page, browser }) => {
  requireUi('Dev B', 'header-call', 'call-screen', 'incoming-call', 'incoming-call-accept', 'call-leave', 'message-call');
  await asAlice(page);
  const bob = await other(browser, 'bob');
  await openRoom(page, R.vault);
  const dave = await other(browser, 'dave'); // the third context, last; closed in afterEach of this same test

  const t0 = Date.now();
  await page.getByTestId('header-call').click();
  for (const p of [bob.page, dave.page]) {
    await expect(incomingCard(p)).toBeVisible({ timeout: 10_000 });
    await expect(incomingCard(p)).toHaveAttribute('data-room-id', R.vault);
    await expect(p.getByTestId('incoming-call-room')).toContainText('#vault');
  }
  const rings = await callEventsSince(page, R.vault, t0, RING_TYPE);
  expect(rings).toHaveLength(1);
  expect(new Set((rings[0]!.content['m.mentions'] as { user_ids: string[] }).user_ids), 'a <= 5 member room rings every other member').toEqual(new Set([BOB, DAVE]));
  await bob.page.getByTestId('incoming-call-accept').click();
  await dave.page.getByTestId('incoming-call-accept').click();
  for (const p of [page, bob.page, dave.page]) {
    await waitForCallState(p, (s) => s.activeCall?.state === 'connected' && s.activeCall.participants.length === 3 && s.activeCall.participants.every((x) => x.connected && (x.isSelf || x.keyState === 'ok')), 'three connected with keys', 40_000);
  }
  await expect(page.getByTestId('call-screen').locator('[data-testid^="call-participant-@"]')).toHaveCount(3);

  await bob.page.getByTestId('call-leave').click();
  await expect(callScreen(bob.page)).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('call-screen').locator('[data-testid^="call-participant-@"]')).toHaveCount(2, { timeout: 15_000 });
  await expect(callScreen(page)).toHaveAttribute('data-state', 'connected');
  await expect(participantTile(page, DAVE)).toBeVisible();

  await page.getByTestId('call-leave').click();
  await expect(callScreen(page)).toHaveCount(0, { timeout: 5_000 });
  // Room calls stay open: dave is alone and still connected until he leaves himself.
  await waitForCallState(dave.page, (s) => s.activeCall?.state === 'connected' && s.activeCall.participants.length === 1, 'dave alone, still in the call', 20_000);
  expect(await callEventsSince(dave.page, R.vault, t0, LINE_TYPE, 'ended'), 'the first two leavers sent no ended line').toEqual([]);
  await dave.page.getByTestId('call-leave').click();
  await expect.poll(async () => (await callEventsSince(page, R.vault, t0, LINE_TYPE, 'ended')).length, { timeout: 15_000 }).toBe(1);
  const ended = (await callEventsSince(page, R.vault, t0, LINE_TYPE, 'ended'))[0]!;
  expect(ended.sender).toBe(DAVE);
  expect(ended.content.call_id).toBe(rings[0]!.eventId);
  expect.soft(new Set((ended.content.participants as string[] | undefined) ?? []), 'ended.participants = everyone who was in the call').toEqual(new Set([ALICE, BOB, DAVE]));
  await expect(page.locator('[data-testid="message-call"][data-kind="ended"]').last()).toContainText('Call ended');
  await dave.close();
});

// ------------------------------------------------------------------------------------------------ AC-R2-6 / R6-7 (P1)

test('AC-R2-6, R6-7: dave\'s media keys blocked -> "No call keys from Dave yet" on alice\'s tile; unblock + re-join -> ok', async ({ page, browser }) => {
  requireUi('Dev B', 'call-screen', 'call-participant-nokeys');
  await asAlice(page);
  const dave = await other(browser, 'dave');
  await openRoom(page, R.vault);
  await callHook(page).join(R.vault);
  await waitForCallState(page, (s) => s.activeCall?.state === 'connected', 'alice in the #vault call', 30_000);

  const unblock = await blockMediaKeys(dave.page);
  await callHook(dave.page).join(R.vault);
  await waitForCallState(page, (s) => remoteOf(s, DAVE)?.keyState === 'missing', "alice reports dave's key missing", 30_000);
  await expect(participantTile(page, DAVE)).toHaveAttribute('data-keys', 'missing');
  await expect(page.getByTestId('call-participant-nokeys')).toHaveText(`No call keys from ${DISPLAY_NAMES.dave} yet`);
  await expect(callScreen(page)).toHaveAttribute('data-state', 'connected');

  await callHook(dave.page).leave();
  await waitForCallState(page, (s) => !remoteOf(s, DAVE), 'dave left', 20_000);
  await unblock();
  await callHook(dave.page).join(R.vault);
  await waitForCallState(page, connectedWith(DAVE), "dave's key arrives after the re-join", 30_000);
  await expect(participantTile(page, DAVE)).toHaveAttribute('data-keys', 'ok');
  await expect(page.getByTestId('call-participant-nokeys')).toHaveCount(0);
});

// ------------------------------------------------------------------------------------------------ AC-R3-1 / R4-6 (P1)

test('AC-R3-1 (P1), R4-6: a DM with only a @signal_ ghost has no call button; a group with a ghost shows "Codec members only"', async ({ page }) => {
  requireUi('Dev B', 'header-call', 'header-call-hint');
  requireUi('Principal', 'bridged-dm', 'codec-only');
  const alice = await asUser('alice');
  const ghost = await freshUser('signal_');
  // DM: alice + the ghost, encrypted, `m.bridge` naming the ghost, listed in alice's m.direct.
  const dm = await createRoom(alice.token, { name: uniqueName('qa-bridged-dm'), encrypted: true, invite: [ghost.userId] });
  await joinRoom(ghost.token, dm);
  await sendStateEvent(alice.token, dm, 'm.bridge', `qa-bridge-${Date.now()}`, { bridgebot: ghost.userId, protocol: { id: 'signal', displayname: 'Signal' }, channel: { id: ghost.userId } });
  const direct = (await alice.directMap()) as Record<string, string[]>;
  await fetch(`${HS_URL}/_matrix/client/v3/user/${encodeURIComponent(ALICE)}/account_data/m.direct`, {
    method: 'PUT',
    headers: { 'authorization': `Bearer ${alice.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...direct, [ghost.userId]: [dm] }),
  });
  // Group: #vault-like encrypted room with bob and the ghost.
  const group = await createRoom(alice.token, { name: uniqueName('qa-bridged-group'), encrypted: true, spaceId: R.acme, invite: [BOB, ghost.userId] });
  await (await asUser('bob')).joinRoom(group);
  await joinRoom(ghost.token, group);

  await asAlice(page);
  await expect.poll(async () => (await callHook(page).canCall(dm)).reason, { timeout: 15_000 }).toBe('bridged-dm');
  const g = await callHook(page).canCall(group);
  expect(callAllowed(g)).toBe(true);
  expect(g.hint).toBe('codec-only');

  await openHome(page);
  await openDm(page, dm);
  await expect(page.getByTestId('header-call')).toHaveCount(0);
  await openRoom(page, group);
  await expect(page.getByTestId('header-call')).toBeVisible();
  await expect(page.getByTestId('header-call-hint')).toHaveText('Codec members only');
});
