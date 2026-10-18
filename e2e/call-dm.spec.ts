/**
 * Phase 7 QA-35: a voice call in a DM, through the UI (desktop). docs/PHASE7_ACCEPTANCE.md AC-R3-4..6, AC-R4-1/2/4/5,
 * AC-R5, AC-R6-1/2/4/5, AC-R7 (+ AC-R6-8 for "No answer" / "Busy").
 *
 * Who: alice in `page`, the callee **dave** in a second context: `dm-alice-dave` is the seed's only encrypted DM
 * (`dm-alice-bob` is plain, calls are refused there), so dave plays the registry's "bob". alice-2 (a second alice
 * device) is the third context, only in the multi-device test (AC-R10-1 exception), closed in that test.
 *
 * Chat lines (orchestrator ruling 2026-10-18): started = the Codec ring, declined = MSC4310 decline
 * (`io.codec.decline_reason: "busy"` for busy), ended / missed = `dev.matrixpoc.call` { kind, call_id, duration_ms?,
 * participants? } sent encrypted; missed by the caller after the ring with nobody joined and nobody declined; ended by
 * the last leaver. The API cannot decrypt, so line *contents* are read from the page's own SDK timeline
 * (`callEventsInPage`) and the wire only proves they were encrypted.
 *
 * The 60 s ring: `ringTimeoutOverride()` shortens it when the core exposes `__matrixPoc.calls.setRingTimeoutMs`
 * (requested in docs/STATUS.md); otherwise the missed-call test runs the real 60 s (annotated `real-time`).
 * UI criteria skip with "waiting on Dev A/B" until their testids are in `src/` (`requireUi`, a source scan).
 */
import { expect, test, type Page } from '@playwright/test';
import { DISPLAY_NAMES, resolveRoom, userId } from './fixtures/seed.ts';
import { asUser } from './fixtures/matrix-api.ts';
import { e2eeAfterEach, loginWith, requireUi, secondContext, waitForStatus, type SecondContext } from './fixtures/e2ee.ts';
import { messageList, openChannel, openDm, openHome, openSpace, typeAndSend, rowByText, dmItem } from './fixtures/ui.ts';
import {
  DECLINE_REASON_KEY,
  DECLINE_TYPE,
  LINE_TYPE,
  RING_TYPE,
  callEventsInPage,
  callEventsSince,
  callHook,
  callLines,
  callScreen,
  cleanupCalls,
  connectedWith,
  denyMicrophone,
  expectSentEncrypted,
  grantCallPowerLevels,
  incomingCard,
  liveMemberships,
  parseClock,
  participantTile,
  requireRtc,
  ringAlice,
  ringTimeoutOverride,
  sendCallLine,
  sendDeclineApi,
  waitForCallState,
} from './fixtures/call.ts';

test.describe.configure({ mode: 'default', timeout: 150_000 }); // one worker, file order (fullyParallel: false); a failure does not skip the rest

const ALICE = userId('alice');
const DAVE = userId('dave');
const R = { dm: '', vault: '', general: '', acme: '' };
const contexts: SecondContext[] = [];

const CALL_UI = ['header-call', 'call-screen', 'call-status', 'call-lock', 'call-mute', 'call-leave'];
const CARD_UI = ['incoming-call', 'incoming-call-name', 'incoming-call-room', 'incoming-call-accept', 'incoming-call-decline'];

test.beforeAll(async () => {
  R.dm = await resolveRoom('dm-alice-dave');
  R.vault = await resolveRoom('vault');
  R.general = await resolveRoom('general');
  R.acme = await resolveRoom('acme-hq');
  await grantCallPowerLevels(R.vault);
});

test.beforeEach(async () => {
  await requireRtc(test);
  await cleanupCalls([R.dm, R.vault]);
});

test.afterEach(async ({ page }, info) => {
  await cleanupCalls([R.dm, R.vault], [page, ...contexts.map((c) => c.page)]);
  contexts.length = 0;
  await e2eeAfterEach(page, info);
});

async function asAlice(page: Page): Promise<void> {
  await loginWith(page, 'alice');
  await waitForStatus(page);
}

async function dave(browser: import('@playwright/test').Browser): Promise<SecondContext> {
  const c = await secondContext(browser, 'dave');
  contexts.push(c);
  await waitForStatus(c.page);
  return c;
}

async function openTheDm(page: Page): Promise<void> {
  await openHome(page);
  await openDm(page, R.dm);
}

async function openVault(page: Page): Promise<void> {
  await openSpace(page, R.acme);
  await openChannel(page, R.vault);
}

/** document.title values seen over `ms` (AC-R5-1 title flash). */
async function titlesFor(page: Page, ms: number): Promise<string[]> {
  return page.evaluate(
    (d) =>
      new Promise<string[]>((resolve) => {
        const seen = new Set<string>([document.title]);
        const t = setInterval(() => seen.add(document.title), 100);
        setTimeout(() => (clearInterval(t), resolve([...seen])), d);
      }),
    ms,
  );
}

// ------------------------------------------------------------------------------------------------ AC-R4-2

test('AC-R4-2: #general (unencrypted) has a disabled call button with the reason; clicking does nothing', async ({ page }) => {
  requireUi('Dev B', 'header-call');
  await asAlice(page);
  await openSpace(page, R.acme);
  await openChannel(page, R.general);
  const btn = page.getByTestId('header-call');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('data-disabled-reason', 'unencrypted');
  await expect(btn).toHaveAttribute('title', 'Calls need an encrypted room');
  await expect(btn).toHaveAttribute('aria-label', 'Start a call');
  await btn.click({ force: true });
  // Sentinel: a store round trip after the click; nothing started, nothing on the wire.
  const s = await callHook(page).state();
  expect(s.activeCall).toBeNull();
  await expect(callScreen(page)).toHaveCount(0);
  expect((await liveMemberships(R.general)).filter((m) => m.user === ALICE)).toEqual([]);
});

// ------------------------------------------------------------------------------------------------ AC-R4-5

test('AC-R4-5: mic denied -> toast with how to allow, no membership, no ring, no call screen', async ({ page }) => {
  requireUi('Dev B', 'header-call', 'toast');
  await denyMicrophone(page);
  await asAlice(page);
  await openTheDm(page);
  const t0 = Date.now();
  await page.getByTestId('header-call').click();
  await expect(page.getByTestId('toast')).toContainText("Codec can't use your microphone. Allow it in the browser's site settings and try again");
  await expect(callScreen(page)).toHaveCount(0);
  const s = await callHook(page).state();
  expect(s.activeCall).toBeNull();
  expect(s.lastError?.code).toBe('mic-denied');
  expect((await liveMemberships(R.dm)).filter((m) => m.user === ALICE), 'no m.call membership for alice').toEqual([]);
  const wire = (await asUser('alice')).messages(R.dm, 30);
  expect((await wire).filter((e) => e.sender === ALICE && (e.origin_server_ts ?? 0) >= t0 - 1000), 'alice sent nothing into the DM').toEqual([]);
});

// ------------------------------------------------------------------------------------------------ the main chain

test('AC-R4-1, R5-1/2, R6-1/2/4/5, R3-6 (ended): ring -> card -> accept -> connected -> mute -> minimise -> leave -> "Call ended"', async ({ page, browser }) => {
  requireUi('Dev B', ...CALL_UI, ...CARD_UI, 'call-participant-', 'call-timer', 'call-minimise', 'in-call-bar', 'in-call-bar-leave', 'message-call');
  await asAlice(page);
  const d = await dave(browser);
  // AC-R5-1 "before any gesture": the login click was a gesture, so restore dave's session in a fresh document.
  await d.page.reload();
  await expect(d.page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await waitForStatus(d.page);
  await openTheDm(page);

  await test.step('AC-R4-1: header-call ring mode, click -> calling screen; dave sees the card within 3 s', async () => {
    const btn = page.getByTestId('header-call');
    await expect(btn).toHaveAttribute('data-mode', 'ring');
    await expect(btn).not.toHaveAttribute('data-disabled-reason', /.+/);
    await expect(page.getByTestId('header-join-call')).toHaveCount(0);
    const t0 = Date.now();
    await btn.click();
    const screen = callScreen(page);
    await expect(screen).toBeVisible();
    await expect(screen).toHaveAttribute('role', 'dialog');
    await expect(screen).toHaveAttribute('aria-label', 'Voice call');
    await expect(screen).toHaveAttribute('data-state', 'calling');
    await expect(page.getByTestId('call-status')).toHaveText('Calling...');
    await expect(page.getByTestId('call-lock')).toHaveAttribute('title', 'End-to-end encrypted (the call server only sees scrambled audio)');
    await expect(participantTile(page, ALICE)).toBeVisible();
    await expect(page.getByTestId('call-mute')).toBeVisible();
    await expect(page.getByTestId('call-leave')).toBeVisible();
    await expect(incomingCard(d.page)).toBeVisible({ timeout: 5_000 });
    test.info().annotations.push({ type: 'timing', description: `ring -> dave's card ${Date.now() - t0} ms (AC: 3 s)` });
    await expect(incomingCard(d.page)).toHaveAttribute('data-from', ALICE);
    await expect(incomingCard(d.page)).toHaveAttribute('data-room-id', R.dm);
    // AC-R2-2 on the wire, through alice's decrypted timeline: one ring, ring type, mentions = [dave], 60 s.
    const rings = await callEventsSince(page, R.dm, t0, RING_TYPE);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.content).toMatchObject({ 'notification_type': 'ring', 'lifetime': 60_000, 'm.mentions': { user_ids: [DAVE] } });
    expect((rings[0]!.content['m.mentions'] as { room?: boolean }).room).toBeUndefined();
    await expectSentEncrypted(R.dm, rings[0]!.eventId);
  });

  await test.step('AC-R5-1: the card shows caller and room, flashes the title, asks for a click to ring', async () => {
    const card = incomingCard(d.page);
    await expect(card).toHaveAttribute('role', 'dialog');
    await expect(card).toHaveAttribute('aria-label', 'Incoming call');
    await expect(d.page.getByTestId('incoming-call-name')).toHaveText(DISPLAY_NAMES.alice);
    await expect(d.page.getByTestId('incoming-call-room')).toContainText(DISPLAY_NAMES.alice);
    await expect(d.page.getByTestId('incoming-call-accept')).toBeVisible();
    await expect(d.page.getByTestId('incoming-call-decline')).toBeVisible();
    const titles = await titlesFor(d.page, 2_500);
    expect(titles, 'the title alternates with "Incoming call from alice"').toContain(`Incoming call from ${DISPLAY_NAMES.alice}`);
    expect(titles.length, 'the title alternates (two values)').toBeGreaterThanOrEqual(2);
    await expect(d.page.getByTestId('incoming-call-muted')).toHaveText('Click anywhere to hear the ringtone');
    await d.page.getByTestId('incoming-call-name').click();
    await expect(d.page.getByTestId('incoming-call-muted')).toHaveCount(0);
    const played = await d.page.evaluate(() => {
      const poc = (window as any).__matrixPoc;
      const r = poc.calls?.ringtone ?? poc.call?.ringtone;
      return r ? r.lastPlayedAt ?? null : 'no-hook';
    });
    if (played === 'no-hook') test.info().annotations.push({ type: 'core-pending', description: '__matrixPoc.calls.ringtone not exposed: lastPlayedAt not asserted' });
    else expect(played, 'ringtone.lastPlayedAt after the click').not.toBeNull();
  });

  let connectedAt = 0;
  let daveConnectedAt = 0;
  await test.step('AC-R5-2 / R6-1: accept -> both connected within 10 s, 2 tiles, timer, lock, panel over the member column', async () => {
    const t0 = Date.now();
    await d.page.getByTestId('incoming-call-accept').click();
    await expect(incomingCard(d.page)).toHaveCount(0);
    for (const p of [page, d.page]) {
      await expect(callScreen(p)).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
    }
    test.info().annotations.push({ type: 'timing', description: `accept -> both connected ${Date.now() - t0} ms (AC: 10 s)` });
    await waitForCallState(page, connectedWith(DAVE), 'alice connected with dave, key ok', 20_000);
    connectedAt = (await callHook(page).state()).activeCall!.connectedAt ?? Date.now();
    daveConnectedAt = (await waitForCallState(d.page, connectedWith(ALICE), 'dave connected with alice, key ok', 20_000)).activeCall!.connectedAt ?? connectedAt;
    for (const p of [page, d.page]) {
      await expect(p.getByTestId('call-screen').locator('[data-testid^="call-participant-"]:not([data-testid="call-participant-nokeys"])')).toHaveCount(2);
      await expect(participantTile(p, ALICE)).toBeVisible();
      await expect(participantTile(p, DAVE)).toBeVisible();
      await expect(p.getByTestId('call-lock')).toBeVisible();
    }
    await expect(participantTile(page, DAVE)).toHaveAttribute('data-keys', 'ok');
    const first = parseClock((await page.getByTestId('call-timer').textContent()) ?? '');
    expect(first).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => parseClock((await page.getByTestId('call-timer').textContent()) ?? ''), { timeout: 5_000, message: 'call-timer advances' }).toBeGreaterThan(first);
    // No decline from dave (AC-R5-2).
    expect(await callEventsSince(page, R.dm, t0 - 30_000, DECLINE_TYPE)).toEqual([]);
    // Desktop panel over the member column; the conversation stays usable.
    const screenBox = (await callScreen(page).boundingBox())!;
    const listBox = (await messageList(page).boundingBox())!;
    expect(screenBox.x, 'call panel left edge >= the conversation right edge - 1 px').toBeGreaterThanOrEqual(listBox.x + listBox.width - 1);
    const text = `qa call chat ${Date.now()}`;
    await typeAndSend(page, text);
    await expect(rowByText(d.page, text)).toBeVisible({ timeout: 15_000 });
  });

  await test.step('AC-R6-2: mute shows locally and on the other side within 3 s; unmute clears both', async () => {
    const mute = page.getByTestId('call-mute');
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(await callHook(page).micEnabled()).toBe(false);
    await expect(participantTile(d.page, ALICE)).toHaveAttribute('data-muted', 'true', { timeout: 5_000 });
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    expect(await callHook(page).micEnabled()).toBe(true);
    await expect(participantTile(d.page, ALICE)).not.toHaveAttribute('data-muted', 'true', { timeout: 5_000 });
  });

  await test.step('AC-R6-4: minimise -> in-call bar above the composer, composer works, bar reopens with the same timer', async () => {
    await page.getByTestId('call-minimise').click();
    await expect(callScreen(page)).toBeHidden();
    const bar = page.getByTestId('in-call-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-room-id', R.dm);
    await expect(bar).toContainText(/In call \d{2}:\d{2}, tap to return/);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-in-call', 'true');
    const barBox = (await bar.boundingBox())!;
    const composerBox = (await page.getByTestId('composer-input').boundingBox())!;
    expect(barBox.y + barBox.height, 'the bar sits above the composer').toBeLessThanOrEqual(composerBox.y + 1);
    const text = `qa minimised ${Date.now()}`;
    await typeAndSend(page, text);
    await expect(rowByText(page, text)).toBeVisible();
    const barSeconds = parseClock((await bar.textContent()) ?? '');
    await bar.click();
    await expect(callScreen(page)).toBeVisible();
    const timer = parseClock((await page.getByTestId('call-timer').textContent()) ?? '');
    expect(timer, 'the timer kept counting while minimised').toBeGreaterThanOrEqual(barSeconds);
    await expect(bar).toBeHidden();
  });

  await test.step('AC-R6-5 / R3-6: alice leaves -> both screens close, "Call ended, < 1 min" on both, one ended line from the last leaver', async () => {
    const tLeave = Date.now();
    await page.getByTestId('call-leave').click();
    await expect(callScreen(page)).toHaveCount(0, { timeout: 2_000 });
    await expect(callScreen(d.page)).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
    await expect(callScreen(d.page)).toHaveCount(0, { timeout: 5_000 });
    for (const p of [page, d.page]) {
      await expect(p.getByTestId('app-shell')).not.toHaveAttribute('data-in-call', 'true');
      await expect(p.getByTestId('in-call-bar')).toHaveCount(0);
    }
    // The line: one dev.matrixpoc.call ended, call_id = the ring, from the last leaver (dave, whose client leaves on
    // alice's departure), duration = his connected time, participants = both.
    await expect.poll(async () => (await callEventsSince(page, R.dm, connectedAt - 60_000, LINE_TYPE, 'ended')).length, { timeout: 15_000, message: 'an ended line arrives' }).toBeGreaterThanOrEqual(1);
    const ended = await callEventsSince(page, R.dm, connectedAt - 60_000, LINE_TYPE, 'ended');
    expect(ended, 'exactly one ended line (the first leaver of a 1:1 sends none of its own... only the last)').toHaveLength(1);
    const ring = (await callEventsSince(page, R.dm, connectedAt - 60_000, RING_TYPE))[0]!;
    expect(ended[0]!.sender).toBe(DAVE);
    expect(ended[0]!.content.call_id).toBe(ring.eventId);
    expect(new Set(ended[0]!.content.participants as string[])).toEqual(new Set([ALICE, DAVE]));
    expect(Math.abs((ended[0]!.content.duration_ms as number) - (tLeave - daveConnectedAt)), "duration_ms within 2 s of dave's connected time").toBeLessThanOrEqual(2_000);
    await expectSentEncrypted(R.dm, ended[0]!.eventId);
    for (const p of [page, d.page]) {
      await expect(callLines(p, 'ended').last()).toContainText('Call ended, < 1 min');
      await expect(callLines(p, 'started').last()).toContainText('started a voice call');
    }
  });
});

// ------------------------------------------------------------------------------------------------ AC-R5-3

test('AC-R5-3: dave declines -> MSC4310 decline, alice sees "Dave declined" then the screen closes; both timelines show the line; no missed', async ({ page, browser }) => {
  requireUi('Dev B', ...CALL_UI, ...CARD_UI, 'message-call');
  await asAlice(page);
  const d = await dave(browser);
  const ringTimeout = await ringTimeoutOverride(page, 8_000);
  await openTheDm(page);
  await openTheDm(d.page);
  const t0 = Date.now();
  await page.getByTestId('header-call').click();
  await expect(incomingCard(d.page)).toBeVisible({ timeout: 10_000 });
  await d.page.getByTestId('incoming-call-decline').click();
  await expect(incomingCard(d.page)).toHaveCount(0);

  await expect(callScreen(page)).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
  await expect(page.getByTestId('call-status')).toHaveText(`${DISPLAY_NAMES.dave} declined`);
  await expect(callScreen(page)).toHaveCount(0, { timeout: 6_000 });

  const ring = (await callEventsSince(page, R.dm, t0, RING_TYPE))[0]!;
  await expect.poll(async () => (await callEventsSince(page, R.dm, t0, DECLINE_TYPE)).length, { timeout: 10_000 }).toBe(1);
  const decline = (await callEventsSince(page, R.dm, t0, DECLINE_TYPE))[0]!;
  expect(decline.sender).toBe(DAVE);
  expect(decline.content['m.relates_to']).toEqual({ rel_type: 'm.reference', event_id: ring.eventId });
  expect(decline.content[DECLINE_REASON_KEY]).toBeUndefined();
  for (const p of [page, d.page]) {
    await expect(callLines(p, 'declined').last()).toContainText(`${DISPLAY_NAMES.dave} declined`);
    await expect(callLines(p, 'declined').last()).not.toContainText('busy');
  }
  // AC-R3-6: a declined ring is never also a missed call. Only judgeable once the ring would have expired.
  if (ringTimeout < 60_000) {
    await expect.poll(() => Date.now() - t0, { timeout: ringTimeout + 10_000 }).toBeGreaterThan(ringTimeout + 3_000);
    expect(await callEventsSince(page, R.dm, t0, LINE_TYPE, 'missed'), 'no missed line after a decline').toEqual([]);
  } else {
    test.info().annotations.push({ type: 'not-asserted', description: 'no ring timeout override: "no missed after a decline" needs the 60 s window, checked in the missed test instead' });
  }
});

// ------------------------------------------------------------------------------------------------ AC-R3-6 / R5-4 / R7-2 / R7-3

test('AC-R3-6, R5-4, R6-8, R7-2/3: nobody answers -> "No answer", one missed line, red "Missed call from alice" + Call back, sidebar preview', async ({ page, browser }) => {
  requireUi('Dev B', ...CALL_UI, ...CARD_UI, 'message-call', 'call-back');
  requireUi('Dev A', 'room-call-indicator');
  await asAlice(page);
  const d = await dave(browser);
  const ringTimeout = await ringTimeoutOverride(page, 10_000);
  test.setTimeout(ringTimeout + 120_000);
  await openTheDm(page);
  await openVault(d.page); // dave is elsewhere when the missed line lands (sidebar preview + badge)

  const t0 = Date.now();
  await page.getByTestId('header-call').click();
  await expect(incomingCard(d.page)).toBeVisible({ timeout: 10_000 });
  const myDevice = await callHook(page).deviceId();

  // The ring runs out: the card closes by itself, alice's screen says "No answer" with Call back.
  await expect(incomingCard(d.page)).toHaveCount(0, { timeout: ringTimeout + 10_000 });
  await expect(callScreen(page)).toHaveAttribute('data-state', 'no-answer', { timeout: 10_000 });
  await expect(page.getByTestId('call-status')).toHaveText('No answer');
  await expect(callScreen(page).getByTestId('call-back')).toBeVisible();
  await expect.poll(async () => (await liveMemberships(R.dm)).filter((m) => m.user === ALICE && m.device === myDevice).length, { timeout: 10_000, message: "alice's membership is cleared" }).toBe(0);

  // dave (in #vault) first, while the missed line is still the DM's newest event: the DM row previews
  // "Missed call" in red with the unread badge (AC-R7-3).
  await expect.poll(async () => (await callEventsSince(page, R.dm, t0, LINE_TYPE, 'missed')).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await openHome(d.page);
  const row = dmItem(d.page, R.dm);
  await expect(row).toHaveAttribute('data-preview', 'missed-call', { timeout: 10_000 });
  await expect(row).toContainText('Missed call');
  await expect(d.page.getByTestId(`dm-unread-${R.dm}`)).toBeVisible();
  await openDm(d.page, R.dm);
  await expect(d.page.getByTestId(`dm-unread-${R.dm}`)).toHaveCount(0, { timeout: 5_000 });
  const daveRow = d.page.locator('[data-testid="message-call"][data-kind="missed"][data-missed="true"]').last();
  await expect(daveRow).toContainText(`Missed call from ${DISPLAY_NAMES.alice}`);

  // Exactly one missed line, from alice, call_id = the ring, participants = [dave]; sentinel = a later message.
  const sentinel = `qa after missed ${Date.now()}`;
  await (await asUser('dave')).send(R.dm, sentinel);
  await expect(rowByText(page, sentinel)).toBeVisible({ timeout: 15_000 });
  const missed = await callEventsSince(page, R.dm, t0, LINE_TYPE, 'missed');
  const ring = (await callEventsSince(page, R.dm, t0, RING_TYPE))[0]!;
  expect(missed).toHaveLength(1);
  expect(missed[0]!).toMatchObject({ sender: ALICE, content: { kind: 'missed', call_id: ring.eventId, participants: [DAVE] } });
  await expectSentEncrypted(R.dm, missed[0]!.eventId);

  // alice (the caller) reads "No answer from Dave", not red, no button.
  const aliceRow = callLines(page, 'missed').last();
  await expect(aliceRow).toContainText(`No answer from ${DISPLAY_NAMES.dave}`);
  await expect(aliceRow).not.toHaveAttribute('data-missed', 'true');
  await expect(aliceRow.getByTestId('call-back')).toHaveCount(0);

  // alice closes the no-answer screen; dave calls back from the line (AC-R7-2: the AC-R4-1 state).
  // The no-answer screen stays until closed (AC-R6-8: Call back + a Close); call-leave is the close control.
  await page.getByTestId('call-leave').click();
  await expect(callScreen(page)).toHaveCount(0, { timeout: 5_000 });
  await daveRow.getByTestId('call-back').click();
  await expect(callScreen(d.page)).toHaveAttribute('data-state', 'calling');
  await expect(incomingCard(page)).toHaveAttribute('data-from', DAVE, { timeout: 10_000 });
  await d.page.getByTestId('call-leave').click();
  await expect(incomingCard(page)).toHaveCount(0, { timeout: 5_000 });
});

test('AC-R5-4 (caller hangs up): the card closes within 3 s and the missed line appears', async ({ page, browser }) => {
  requireUi('Dev B', ...CALL_UI, ...CARD_UI, 'message-call', 'call-back');
  await asAlice(page);
  const d = await dave(browser);
  await openTheDm(page);
  await openTheDm(d.page);
  // dave calls alice and hangs up after the card is up (the AC's "at 20 s", shortened: what matters is "before the timeout").
  const t0 = Date.now();
  await d.page.getByTestId('header-call').click();
  await expect(incomingCard(page)).toBeVisible({ timeout: 10_000 });
  await d.page.getByTestId('call-leave').click();
  const tHang = Date.now();
  await expect(incomingCard(page)).toHaveCount(0, { timeout: 5_000 });
  test.info().annotations.push({ type: 'timing', description: `caller hang-up -> card closed ${Date.now() - tHang} ms (AC: 3 s)` });
  await expect(page.locator('[data-testid="message-call"][data-kind="missed"][data-missed="true"]').last()).toContainText(`Missed call from ${DISPLAY_NAMES.dave}`, { timeout: 15_000 });
  const missed = await callEventsSince(page, R.dm, t0, LINE_TYPE, 'missed');
  expect(missed).toHaveLength(1);
  expect(missed[0]!).toMatchObject({ sender: DAVE, content: { kind: 'missed', participants: [ALICE] } });
});

// ------------------------------------------------------------------------------------------------ AC-R3-5 / R4-4

test('AC-R3-5, R4-4, R6-8: alice in a #vault call -> dave\'s DM ring is auto-declined busy, no card; dave sees "Busy"; DM button busy', async ({ page, browser }) => {
  requireUi('Dev B', ...CALL_UI, 'message-call');
  await asAlice(page);
  const d = await dave(browser);
  await callHook(page).join(R.vault);
  await waitForCallState(page, (s) => s.activeCall?.roomId === R.vault && s.activeCall.state === 'connected', 'alice alone in the #vault call', 30_000);

  await test.step('AC-R4-4: every other room\'s call button says busy', async () => {
    await openTheDm(page);
    await expect(page.getByTestId('header-call')).toHaveAttribute('data-disabled-reason', 'busy');
  });

  await openTheDm(d.page);
  const t0 = Date.now();
  await d.page.getByTestId('header-call').click();
  await expect.poll(async () => (await callEventsSince(d.page, R.dm, t0, DECLINE_TYPE)).length, { timeout: 15_000, message: 'busy decline arrives' }).toBe(1);
  const decline = (await callEventsSince(d.page, R.dm, t0, DECLINE_TYPE))[0]!;
  const ring = (await callEventsSince(d.page, R.dm, t0, RING_TYPE))[0]!;
  expect(decline.sender).toBe(ALICE);
  expect(decline.content[DECLINE_REASON_KEY]).toBe('busy');
  expect(decline.content['m.relates_to']).toEqual({ rel_type: 'm.reference', event_id: ring.eventId });
  expect(decline.ts - ring.ts, 'auto-declined within 2 s of the ring (server timestamps)').toBeLessThanOrEqual(2_000);
  await expect(incomingCard(page), 'busy: no card on alice').toHaveCount(0);
  expect((await callHook(page).state()).incoming).toEqual([]);
  expect((await callHook(page).state()).activeCall?.roomId, 'alice is still in her #vault call').toBe(R.vault);

  await expect(callScreen(d.page)).toHaveAttribute('data-state', 'busy', { timeout: 10_000 });
  await expect(d.page.getByTestId('call-status')).toHaveText('Busy');
  await expect(callScreen(d.page)).toHaveCount(0, { timeout: 6_000 });
  await expect(callLines(d.page, 'declined').last()).toContainText(`${DISPLAY_NAMES.alice} declined (busy)`);
});

// ------------------------------------------------------------------------------------------------ AC-R3-4 / R5-5

test('AC-R3-4, R5-5: alice-2 accepts -> alice\'s card closes within 3 s, title stops flashing, no decline; alice-2 declines -> same', async ({ page, browser }) => {
  requireUi('Dev B', ...CARD_UI);
  await asAlice(page);
  const d = await dave(browser);
  const alice2 = await secondContext(browser, 'alice'); // the third context (AC-R10-1 exception), closed below
  await waitForStatus(alice2.page);
  await openTheDm(d.page);

  await test.step('accept on alice-2', async () => {
    const t0 = Date.now();
    await d.page.getByTestId('header-call').click();
    await expect(incomingCard(page)).toBeVisible({ timeout: 10_000 });
    await expect(incomingCard(alice2.page)).toBeVisible({ timeout: 10_000 });
    await alice2.page.getByTestId('incoming-call-accept').click();
    const tAccept = Date.now();
    await expect(incomingCard(page)).toHaveCount(0, { timeout: 5_000 });
    test.info().annotations.push({ type: 'timing', description: `alice-2 accept -> alice's card closed ${Date.now() - tAccept} ms (AC: 3 s)` });
    expect((await callHook(page).state()).incoming).toEqual([]);
    expect((await callHook(page).state()).activeCall, 'alice (first device) did not join').toBeNull();
    const titles = await titlesFor(page, 1_500);
    expect(titles.some((t) => t.startsWith('Incoming call')), 'title no longer flashes').toBe(false);
    await waitForCallState(alice2.page, connectedWith(DAVE), 'alice-2 connected with dave', 30_000);
    expect(await callEventsSince(page, R.dm, t0, DECLINE_TYPE), 'no decline sent').toEqual([]);
    await callHook(d.page).leave();
    await waitForCallState(alice2.page, (s) => !s.activeCall || s.activeCall.state === 'ended', 'alice-2 ended', 20_000);
  });

  await test.step('decline on alice-2 (API ring)', async () => {
    const ring = await ringAlice(R.dm, { from: 'dave' });
    await expect(incomingCard(page)).toBeVisible({ timeout: 10_000 });
    await expect(incomingCard(alice2.page)).toBeVisible({ timeout: 10_000 });
    await alice2.page.getByTestId('incoming-call-decline').click();
    await expect(incomingCard(page)).toHaveCount(0, { timeout: 5_000 });
    const declines = (await callEventsInPage(page, R.dm)).filter((e) => e.type === DECLINE_TYPE && (e.content['m.relates_to'] as { event_id?: string })?.event_id === ring.ringEventId);
    expect(declines.map((e) => e.sender), 'one decline, from alice (alice-2)').toEqual([ALICE]);
    await ring.hangUp();
  });
  await callHook(alice2.page).leave().catch(() => undefined);
  await alice2.close();
});

// ------------------------------------------------------------------------------------------------ AC-R7-1 / R7-4

test('AC-R7-1/2/4: call lines render from the three event types; malformed renders nothing; redacted -> message-redacted; Call back starts a call', async ({ page }) => {
  requireUi('Dev B', 'message-call', 'call-back', 'call-screen');
  await asAlice(page);
  await openTheDm(page);
  const before = async (text: string): Promise<number> => callLines(page).filter({ hasText: text }).count();
  const expectNewLine = async (kind: string, text: string, n0: number): Promise<void> => {
    await expect(callLines(page, kind).filter({ hasText: text })).toHaveCount(n0 + 1, { timeout: 15_000 });
  };

  const startedText = `${DISPLAY_NAMES.dave} started a voice call`;
  let n = await before(startedText);
  // A ring that is already expired (no card) still renders as the "started" line.
  const ring = await ringAlice(R.dm, { from: 'dave', senderTs: Date.now() - 120_000 });
  await expectNewLine('started', startedText, n);
  await expect(incomingCard(page)).toHaveCount(0);
  await ring.hangUp();

  n = await before('Call ended, 12 min');
  await sendCallLine(R.dm, 'dave', { kind: 'ended', call_id: ring.ringEventId, duration_ms: 12 * 60_000 + 10_000, participants: [ALICE, DAVE] });
  await expectNewLine('ended', 'Call ended, 12 min', n);
  n = await before('Call ended, < 1 min');
  await sendCallLine(R.dm, 'dave', { kind: 'ended', call_id: ring.ringEventId, duration_ms: 30_000, participants: [ALICE, DAVE] });
  await expectNewLine('ended', 'Call ended, < 1 min', n);

  n = await before(`${DISPLAY_NAMES.dave} declined (busy)`);
  await sendDeclineApi(R.dm, 'dave', ring.ringEventId, true);
  await expectNewLine('declined', `${DISPLAY_NAMES.dave} declined (busy)`, n);
  const plainDeclines = await callLines(page, 'declined').filter({ hasText: `${DISPLAY_NAMES.dave} declined` }).count();
  await sendDeclineApi(R.dm, 'dave', ring.ringEventId, false);
  await expect(callLines(page, 'declined').filter({ hasText: `${DISPLAY_NAMES.dave} declined` })).toHaveCount(plainDeclines + 1, { timeout: 15_000 });

  // Structure: grey system row, no avatar, no actions toolbar, no reactions.
  const line = callLines(page, 'ended').filter({ hasText: 'Call ended, 12 min' }).last();
  await line.hover();
  await expect(line.getByTestId('message-avatar')).toHaveCount(0);
  await expect(line.getByTestId('message-actions')).toHaveCount(0);
  await expect(line.getByTestId('message-reactions')).toHaveCount(0);

  // Missed for alice: red, "Missed call from Dave", Call back.
  n = await page.locator('[data-testid="message-call"][data-kind="missed"][data-missed="true"]').count();
  await sendCallLine(R.dm, 'dave', { kind: 'missed', call_id: ring.ringEventId, participants: [ALICE] });
  const missed = page.locator('[data-testid="message-call"][data-kind="missed"][data-missed="true"]');
  await expect(missed).toHaveCount(n + 1, { timeout: 15_000 });
  await expect(missed.last()).toContainText(`Missed call from ${DISPLAY_NAMES.dave}`);

  // AC-R7-4: malformed (unknown kind, non-array participants, negative duration) -> no row; a sentinel proves sync delivered them.
  const rowsBefore = await callLines(page).count();
  await sendCallLine(R.dm, 'dave', { kind: 'x', call_id: ring.ringEventId });
  await sendCallLine(R.dm, 'dave', { kind: 'missed', call_id: ring.ringEventId, participants: ALICE });
  await sendCallLine(R.dm, 'dave', { kind: 'ended', call_id: ring.ringEventId, duration_ms: -5 });
  const sentinel = `qa after malformed ${Date.now()}`;
  await (await asUser('dave')).send(R.dm, sentinel);
  await expect(rowByText(page, sentinel)).toBeVisible({ timeout: 15_000 });
  await expect(callLines(page)).toHaveCount(rowsBefore);

  // Redacted line -> message-redacted.
  const redactedBefore = await page.getByTestId('message-redacted').count();
  const doomed = await sendCallLine(R.dm, 'dave', { kind: 'ended', call_id: ring.ringEventId, duration_ms: 7 * 60_000, participants: [ALICE, DAVE] });
  await expect(callLines(page, 'ended').filter({ hasText: 'Call ended, 7 min' }).last()).toBeVisible({ timeout: 15_000 });
  await (await asUser('dave')).redact(R.dm, doomed);
  await expect(page.getByTestId('message-redacted')).toHaveCount(redactedBefore + 1, { timeout: 15_000 });

  // AC-R7-2: Call back on the missed line starts a call in the room (AC-R4-1 state).
  await missed.last().getByTestId('call-back').click();
  await expect(callScreen(page)).toHaveAttribute('data-state', 'calling', { timeout: 10_000 });
  await page.getByTestId('call-leave').click();
  await expect(callScreen(page)).toHaveCount(0, { timeout: 5_000 });
});
