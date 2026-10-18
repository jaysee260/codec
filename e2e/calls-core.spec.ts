/**
 * Phase 7 (PRIN, Wave 1): the voice-call core through the local call stack. Desktop, two browser contexts
 * (alice in `page`, dave in `secondContext`) in the encrypted DM `dm-alice-dave`, Chromium's fake microphone
 * (playwright.config.ts `--use-fake-device-for-media-stream`), one LiveKit + lk-jwt per pooled Synapse
 * (scripts/lib/rtc-stack.mjs, started by scripts/hs-pool.mjs).
 *
 * Everything is driven through the dev hook `window.__matrixPoc.calls` (src/app/devtools.ts) so the chain runs before
 * Dev A's / Dev B's call UI exists; what the app claims is cross-checked on the wire with the raw client-server API
 * (`org.matrix.msc3401.call.member` state, the ring as `m.room.encrypted`).
 *
 * Covered: ring -> incoming -> accept -> both connected with E2EE media flowing (bytes received, per-participant keys)
 * -> hang-up -> remote-hangup + history (AC-C1..C4); decline (AC-C5); unencrypted rooms refused (AC-C0);
 * "No call keys from X yet" when the callee's to-device key message never leaves (Advisor Wave 19, F4).
 * Not here: audio output selection, Android, ring timeout (60 s of wall clock; unit-tested in ringing.test.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { resolveRoom, userId } from './fixtures/seed.ts';
import { rawEvent, stateContent } from './fixtures/e2ee-api.ts';
import { e2eeAfterEach, loginWith, secondContext, waitForStatus } from './fixtures/e2ee.ts';

test.describe.configure({ timeout: 120_000 });

type Participant = { userId: string; deviceId: string; identity: string; isSelf: boolean; connected: boolean; hasKey: boolean; keyState: 'ok' | 'pending' | 'missing'; muted: boolean };
type Snapshot = {
  activeCall: { roomId: string; state: string; participants: Participant[]; muted: boolean; connectedAt: number | null; ringing: boolean; endReason: string | null; error: { code: string; message: string } | null; encrypted: true } | null;
  incoming: { roomId: string; notifyEventId: string; from: string; expiresAt: number }[];
  history: { roomId: string; direction: string; outcome: string; peerUserId: string | null; durationMs: number }[];
  liveSessions: Record<string, { userIds: string[]; deviceCount: number }>;
  lastError: { code: string; message: string } | null;
};
type Stats = { identity: string; bytesReceived: number; packetsReceived: number; decrypting: boolean }[];

const calls = {
  state: (page: Page): Promise<Snapshot> => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__matrixPoc.calls.state()))),
  stats: (page: Page): Promise<Stats> => page.evaluate(() => (window as any).__matrixPoc.calls.stats()),
  start: (page: Page, roomId: string, ring = true): Promise<void> => page.evaluate(([r, ring]) => (window as any).__matrixPoc.calls.startCall(r, { ring }), [roomId, ring] as const),
  accept: (page: Page, roomId: string): Promise<void> => page.evaluate((r) => (window as any).__matrixPoc.calls.acceptCall(r), roomId),
  decline: (page: Page, roomId: string): Promise<void> => page.evaluate((r) => (window as any).__matrixPoc.calls.declineCall(r), roomId),
  leave: (page: Page): Promise<void> => page.evaluate(() => (window as any).__matrixPoc.calls.leaveCall()),
  setMuted: (page: Page, muted: boolean): Promise<void> => page.evaluate((m) => (window as any).__matrixPoc.calls.setMuted(m), muted),
  canCall: (page: Page, roomId: string): Promise<{ ok: boolean; reason?: string }> => page.evaluate((r) => (window as any).__matrixPoc.calls.canCall(r), roomId),
  deviceId: (page: Page): Promise<string> => page.evaluate(() => (window as any).__matrixPoc.getClient().getDeviceId()),
};

async function waitState(page: Page, pred: (s: Snapshot) => boolean, message: string, timeout = 30_000): Promise<Snapshot> {
  const deadline = Date.now() + timeout;
  let last: Snapshot | null = null;
  let lastError: string | null = null;
  for (;;) {
    try {
      last = await calls.state(page);
      lastError = null;
      if (pred(last)) return last;
    } catch (e) {
      lastError = String(e);
    }
    if (Date.now() > deadline) throw new Error(`${message}: not reached within ${timeout} ms\nlast state: ${JSON.stringify(last)}${lastError ? `\nlast evaluate error: ${lastError}` : ''}`);
    await page.waitForTimeout(300);
  }
}

/** js-sdk 43 state key for the `m.call#ROOM` slot on a room version without owned state keys. */
const memberKey = (user: string, device: string): string => `_${user}_${device}_m.call`;

const remoteOf = (s: Snapshot, user: string): Participant | undefined => s.activeCall?.participants.find((p) => p.userId === user && !p.isSelf);

const R = { dm: '', dmPlain: '' };
let aliceApi: ApiUser;

test.beforeAll(async () => {
  R.dm = await resolveRoom('dm-alice-dave');
  R.dmPlain = await resolveRoom('dm-alice-bob');
  aliceApi = await asUser('alice');
});

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
});

test('AC-C0: calls are refused in unencrypted rooms, allowed in the encrypted DM', async ({ page }) => {
  await loginWith(page, 'alice');
  await waitForStatus(page);
  expect(await calls.canCall(page, R.dmPlain)).toMatchObject({ ok: false, reason: 'unencrypted' });
  expect(await calls.canCall(page, R.dm)).toEqual({ ok: true });
  await expect(calls.start(page, R.dmPlain)).rejects.toThrow(/encrypted/i);
  const s = await calls.state(page);
  expect(s.activeCall).toBeNull();
  expect(s.lastError?.code).toBe('unencrypted');
});

test('AC-C1..C4: ring, accept, encrypted audio both ways, hang-up, history', async ({ page, browser }) => {
  await loginWith(page, 'alice');
  await waitForStatus(page);
  const dave = await secondContext(browser, 'dave');
  await waitForStatus(dave.page);
  const [aliceDev, daveDev] = await Promise.all([calls.deviceId(page), calls.deviceId(dave.page)]);

  // alice starts a ringing call: her membership is on the wire before the ring, and the ring is encrypted.
  await calls.start(page, R.dm);
  const ringing = await waitState(page, (s) => s.activeCall?.state === 'ringing' || s.activeCall?.state === 'connected', 'alice joined the session');
  expect(ringing.activeCall).toMatchObject({ roomId: R.dm, encrypted: true, error: null });
  const aliceMember = await stateContent(aliceApi.token, R.dm, 'org.matrix.msc3401.call.member', memberKey(userId('alice'), aliceDev));
  expect(aliceMember, 'alice’s org.matrix.msc3401.call.member state (membershipID user:device)').toMatchObject({
    application: 'm.call',
    call_id: '',
    device_id: aliceDev,
    membershipID: `${userId('alice')}:${aliceDev}`,
    foci_preferred: [{ type: 'livekit' }],
  });

  // dave rings.
  const rung = await waitState(dave.page, (s) => s.incoming.length === 1, 'dave sees the incoming call', 20_000);
  expect(rung.incoming[0]).toMatchObject({ roomId: R.dm, from: userId('alice') });
  expect(rung.incoming[0]!.expiresAt).toBeGreaterThan(Date.now());
  const ring = await rawEvent(aliceApi.token, R.dm, rung.incoming[0]!.notifyEventId);
  expect(ring.type, 'the ring is an encrypted room event').toBe('m.room.encrypted');
  expect(ring.sender).toBe(userId('alice'));
  expect((ring.content as { ['m.relates_to']?: unknown })['m.relates_to'], 'reference relation is cleartext').toEqual({ rel_type: 'm.reference', event_id: expect.stringMatching(/^\$/) });

  // dave accepts: both connected, two participants each, keys for the remote device, media flowing both ways.
  await calls.accept(dave.page, R.dm);
  const connectedPred = (me: string) => (s: Snapshot) =>
    s.activeCall?.state === 'connected' && s.activeCall.participants.length === 2 && s.activeCall.participants.every((p) => p.connected) && remoteOf(s, me)?.keyState === 'ok';
  const a = await waitState(page, connectedPred(userId('dave')), 'alice connected with dave (key ok)', 40_000);
  const d = await waitState(dave.page, connectedPred(userId('alice')), 'dave connected with alice (key ok)', 40_000);
  expect(a.activeCall!.ringing).toBe(false);
  expect(a.activeCall!.connectedAt).not.toBeNull();
  expect(remoteOf(a, userId('dave'))).toMatchObject({ deviceId: daveDev, identity: `${userId('dave')}:${daveDev}`, hasKey: true });
  expect(remoteOf(d, userId('alice'))).toMatchObject({ deviceId: aliceDev, identity: `${userId('alice')}:${aliceDev}`, hasKey: true });
  expect(d.incoming, 'accepting clears the incoming entry').toEqual([]);
  expect(a.liveSessions[R.dm]).toMatchObject({ deviceCount: 2 });
  expect(a.liveSessions[R.dm]!.userIds.sort()).toEqual([userId('alice'), userId('dave')].sort());

  for (const [who, p, peer] of [['alice', page, userId('dave')], ['dave', dave.page, userId('alice')]] as const) {
    await expect
      .poll(async () => (await calls.stats(p)).find((s) => s.identity.startsWith(`${peer}:`))?.bytesReceived ?? 0, { message: `${who} receives encrypted audio bytes from ${peer}`, timeout: 20_000 })
      .toBeGreaterThan(0);
    const stat = (await calls.stats(p)).find((s) => s.identity.startsWith(`${peer}:`))!;
    expect(stat.decrypting, `${who}: the receiver has an E2EE decryptor for ${peer}`).toBe(true);
  }

  // mute is local truth and shows on the other side as a muted participant.
  await calls.setMuted(page, true);
  await waitState(page, (s) => s.activeCall?.muted === true && s.activeCall.participants[0]!.muted === true, 'alice muted');
  await waitState(dave.page, (s) => remoteOf(s, userId('alice'))?.muted === true, 'dave sees alice muted');

  // alice hangs up: her membership is gone from the room state, dave ends with remote-hangup, both log a completed call.
  await calls.leave(page);
  const aEnd = await waitState(page, (s) => s.activeCall?.state === 'ended', 'alice ended');
  expect(aEnd.activeCall!.endReason).toBe('hangup');
  const dEnd = await waitState(dave.page, (s) => s.activeCall?.state === 'ended', 'dave ended by remote hang-up', 30_000);
  expect(dEnd.activeCall!.endReason).toBe('remote-hangup');
  await expect.poll(async () => stateContent(aliceApi.token, R.dm, 'org.matrix.msc3401.call.member', memberKey(userId('alice'), aliceDev)), { timeout: 15_000 }).toEqual({});
  await expect.poll(async () => stateContent(aliceApi.token, R.dm, 'org.matrix.msc3401.call.member', memberKey(userId('dave'), daveDev)), { timeout: 15_000 }).toEqual({});
  expect(aEnd.history[0]).toMatchObject({ roomId: R.dm, direction: 'outgoing', outcome: 'completed', peerUserId: userId('dave') });
  expect(dEnd.history[0]).toMatchObject({ roomId: R.dm, direction: 'incoming', outcome: 'completed', peerUserId: userId('alice') });
  expect(aEnd.history[0]!.durationMs).toBeGreaterThan(0);
  expect(await calls.canCall(page, R.dm), 'free to call again once ended').toEqual({ ok: true });
});

test('AC-C5: decline ends the caller’s ring with "declined" and is logged on both sides', async ({ page, browser }) => {
  await loginWith(page, 'alice');
  await waitForStatus(page);
  const dave = await secondContext(browser, 'dave');
  await waitForStatus(dave.page);

  await calls.start(page, R.dm);
  const rung = await waitState(dave.page, (s) => s.incoming.length === 1, 'dave rings', 30_000);
  await calls.decline(dave.page, R.dm);
  const dAfter = await waitState(dave.page, (s) => s.incoming.length === 0, 'dave’s incoming entry cleared');
  expect(dAfter.activeCall).toBeNull();
  expect(dAfter.history[0]).toMatchObject({ roomId: R.dm, direction: 'incoming', outcome: 'declined', peerUserId: userId('alice') });

  const aEnd = await waitState(page, (s) => s.activeCall?.state === 'ended', 'alice’s call ended by the decline', 30_000);
  expect(aEnd.activeCall!.endReason).toBe('declined');
  expect(aEnd.history[0]).toMatchObject({ direction: 'outgoing', outcome: 'declined', peerUserId: userId('dave') });

  // the decline is encrypted on the wire; only its m.reference to the ring is cleartext (so a stale device can match it).
  const room = await aliceApi.messages(R.dm, 20);
  const decline = room.find((e) => e.sender === userId('dave') && (e.content['m.relates_to'] as { event_id?: string } | undefined)?.event_id === rung.incoming[0]!.notifyEventId);
  expect(decline, 'dave’s decline referencing the ring on the wire').toBeTruthy();
  expect(decline!.type).toBe('m.room.encrypted');
  expect(decline!.content['m.relates_to']).toEqual({ rel_type: 'm.reference', event_id: rung.incoming[0]!.notifyEventId });
});

test('Wave 19 F4: a device whose call keys never arrive is shown as "No call keys from X yet" after 5 s', async ({ page, browser }) => {
  await loginWith(page, 'alice');
  await waitForStatus(page);
  const dave = await secondContext(browser, 'dave');
  await waitForStatus(dave.page);
  // dave's media key travels to alice as an Olm to-device message; swallow it (and only it) on dave's side.
  await dave.page.route(/\/_matrix\/client\/v3\/sendToDevice\/m\.room\.encrypted\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await calls.start(page, R.dm);
  await waitState(dave.page, (s) => s.incoming.length === 1, 'dave rings', 30_000);
  await calls.accept(dave.page, R.dm);
  const a = await waitState(page, (s) => remoteOf(s, userId('dave'))?.keyState === 'missing', 'alice reports dave’s key missing after the grace period', 40_000);
  expect(remoteOf(a, userId('dave'))).toMatchObject({ hasKey: false, connected: true });
  expect(a.activeCall!.state).toBe('connected');
  expect(a.activeCall!.error).toBeNull();
  // alice's key did reach dave (the route only blocks dave's sends).
  await waitState(dave.page, (s) => remoteOf(s, userId('alice'))?.keyState === 'ok', 'dave has alice’s key', 20_000);
  await calls.leave(page);
  await waitState(dave.page, (s) => s.activeCall?.state === 'ended', 'dave ended', 30_000);
});
