/**
 * Phase 7 (QA-34) helpers for the voice-call specs: `calls-core.spec.ts` (Principal), `call-dm.spec.ts`,
 * `call-room.spec.ts` (desktop) and `mobile-call.spec.ts` (phone).
 *
 * Contract sources, in order of precedence: the shipped code + docs/ARCHITECTURE.md "Phase 7 deltas", then
 * docs/PHASE7_ACCEPTANCE.md (testid registry, wire shapes, the orchestrator's 2026-10-18 ruling on chat lines).
 * Where they differ the helper accepts both and says so:
 *  - the dev hook is `window.__matrixPoc.calls` (shipped); `__matrixPoc.call` (registry) is accepted as a fallback;
 *  - `canCall(roomId)` returns `{ ok, reason }` (shipped) or `{ allowed, reason }` (registry): use `callAllowed()`;
 *  - the store says `ringing` where the screen says `calling` (`data-state` follows the registry).
 *
 * Rooms: the only encrypted DM in the seed is `dm-alice-dave` (`dm-alice-bob` is plain), so the DM callee is **dave**;
 * `#vault` (alice, bob, dave; encrypted, public preset) is the room-call room. Seeded rooms predate the call power
 * levels (`state_default: 50`), so `grantCallPowerLevels()` patches them through the API as alice (the room admin)
 * before a non-admin joins a call there.
 *
 * Fixture summary:
 *   requireRtc(test)                 skip with `not-available` when this worker's call stack is down (or E2E_NO_RTC=1)
 *   callHook(page).*                 the dev hook: state(), start(), join(), accept(), decline(), leave(), setMuted(), canCall()
 *   waitForCallState(page, pred)     polls the store snapshot (JSON-safe), with the last state in the failure message
 *   cleanupCalls(rooms)              leaves every open page's call, then clears every live `m.call` membership by API
 *   blockMediaKeys(page)             swallows `PUT /sendToDevice/m.room.encrypted/*` (AC-R2-6); returns unblock()
 *   ringAlice(roomId, opts)          an API caller (dave by default): fake membership + the exact Codec ring content
 *   sendCallLine(roomId, as, c)      a `dev.matrixpoc.call` event via API (plaintext: the API cannot encrypt)
 *   callEventsInPage(page, roomId)   decrypted call events from the page's own SDK timeline (ring, decline, lines)
 *   denyMicrophone / stubVibrate / ringTimeoutOverride / thirdContext / mobileContext
 */
import { devices, expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { asUser } from './matrix-api.ts';
import { HS_URL, PASSWORD, userId, type UserKey } from './seed.ts';
import { annotate } from './state.ts';
import { secondContext, type SecondContext } from './e2ee.ts';
import { workerOrigin } from './pool.ts';

export { denyMicrophone } from './mobile.ts';

const V3 = `${HS_URL}/_matrix/client/v3`;

export const MEMBER_TYPE = 'org.matrix.msc3401.call.member';
export const RING_TYPE = 'org.matrix.msc4075.rtc.notification';
export const DECLINE_TYPE = 'org.matrix.msc4310.rtc.decline';
export const LINE_TYPE = 'dev.matrixpoc.call';
export const DECLINE_REASON_KEY = 'io.codec.decline_reason';
export const RING_LIFETIME_MS = 60_000;
export const CALL_KEYS_TIMEOUT_MS = 5_000;
/** The event types `CALL_POWER_LEVELS` (src/lib/rtc/permissions.ts) grants to everyone. */
export const CALL_POWER_EVENTS = [MEMBER_TYPE, RING_TYPE, DECLINE_TYPE, 'io.element.call.encryption_keys'];

/** js-sdk 43 state key of a device's `m.call#ROOM` membership on a room version without owned state keys. */
export const memberStateKey = (user: string, device: string): string => `_${user}_${device}_m.call`;

// ---------------------------------------------------------------------------------------------- availability

let rtcVerdict: Promise<{ ok: true; jwtUrl: string } | { ok: false; reason: string }> | null = null;

/** This worker's jwt service as the app finds it: the homeserver's well-known `org.matrix.msc4143.rtc_foci`. */
export async function focusUrl(): Promise<string | null> {
  const res = await fetch(`${HS_URL}/.well-known/matrix/client`).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { 'org.matrix.msc4143.rtc_foci'?: { type?: string; livekit_service_url?: string }[] };
  return body['org.matrix.msc4143.rtc_foci']?.find((f) => f.type === 'livekit')?.livekit_service_url ?? null;
}

async function probeRtc(): Promise<{ ok: true; jwtUrl: string } | { ok: false; reason: string }> {
  if (process.env.E2E_NO_RTC) return { ok: false, reason: 'E2E_NO_RTC=1: the call stacks were not started' };
  const jwtUrl = await focusUrl();
  if (!jwtUrl) return { ok: false, reason: `${HS_URL}/.well-known/matrix/client has no livekit rtc_foci` };
  const health = await fetch(`${jwtUrl.replace(/\/+$/, '')}/healthz`).catch((e: unknown) => e as Error);
  if (health instanceof Error || !health.ok) {
    return { ok: false, reason: `the jwt service ${jwtUrl}/healthz is not answering (${health instanceof Error ? health.message : `HTTP ${health.status}`}); is the call stack up? (npm run rtc:status)` };
  }
  return { ok: true, jwtUrl };
}

/** Skips the calling test (annotation `not-available`) when the local call stack is not reachable. Probed once per worker. */
export async function requireRtc(t: typeof test = test): Promise<string> {
  rtcVerdict ??= probeRtc();
  const v = await rtcVerdict;
  if (!v.ok) {
    annotate('not-available', v.reason);
    t.skip(true, `not-available: ${v.reason}`);
    return '';
  }
  return v.jwtUrl;
}

// ---------------------------------------------------------------------------------------------- dev hook

export type KeyState = 'ok' | 'pending' | 'missing';
export interface CallParticipant {
  userId: string;
  deviceId: string;
  identity: string;
  isSelf: boolean;
  connected: boolean;
  speaking?: boolean;
  muted: boolean;
  hasKey: boolean;
  keyState: KeyState;
}
export interface CallSnapshot {
  activeCall: {
    roomId: string;
    state: string;
    participants: CallParticipant[];
    muted: boolean;
    startedAt?: number;
    connectedAt: number | null;
    ringing: boolean;
    endReason: string | null;
    error: { code: string; message: string } | null;
    encrypted: true;
  } | null;
  incoming: { roomId: string; notifyEventId: string; from: string; expiresAt: number; receivedAt?: number }[];
  history: { roomId: string; direction: string; outcome: string; peerUserId: string | null; durationMs: number }[];
  liveSessions: Record<string, { userIds: string[]; deviceCount: number }>;
  lastError: { code: string; message: string } | null;
}
export interface Availability {
  ok?: boolean;
  allowed?: boolean;
  reason?: string;
  hint?: string;
}

/** Shipped `{ ok }` or registry `{ allowed }`. */
export const callAllowed = (a: Availability): boolean => (a.ok ?? a.allowed) === true;

/** Runs `fn(hook)` in the page, where hook = `__matrixPoc.calls` (shipped) or `__matrixPoc.call` (registry). */
async function onHook<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async ([src, a]) => {
      const poc = (window as any).__matrixPoc;
      const hook = poc?.calls ?? poc?.call;
      if (!hook) throw new Error('window.__matrixPoc.calls is not exposed (dev build only)');
      // eslint-disable-next-line no-new-func
      const fn = new Function('hook', 'arg', 'poc', `return (async () => { ${src} })();`);
      const out = await fn(hook, a, poc);
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    },
    [body, arg] as const,
  ) as Promise<T>;
}

export function callHook(page: Page) {
  return {
    state: (): Promise<CallSnapshot> =>
      onHook(page, `if (hook.state) return hook.state(); const s = hook.store.getState(); return { activeCall: s.activeCall, incoming: s.incoming, history: s.history ?? [], liveSessions: s.liveSessions ?? s.liveByRoom ?? {}, lastError: s.lastError ?? null };`),
    start: (roomId: string, ring = true): Promise<void> => onHook(page, `await (hook.startCall ?? hook.store.getState().startCall)(arg.roomId, { ring: arg.ring });`, { roomId, ring }),
    join: (roomId: string): Promise<void> => onHook(page, `await (hook.joinCall ?? hook.store.getState().joinCall)(arg);`, roomId),
    accept: (roomId: string): Promise<void> => onHook(page, `await (hook.acceptCall ?? hook.store.getState().acceptCall)(arg);`, roomId),
    decline: (roomId: string): Promise<void> => onHook(page, `await (hook.declineCall ?? hook.store.getState().declineCall)(arg);`, roomId),
    leave: (): Promise<void> => onHook(page, `await (hook.leaveCall ?? hook.store.getState().leaveCall)();`),
    setMuted: (muted: boolean): Promise<void> => onHook(page, `await (hook.setMuted ?? hook.store.getState().setMuted)(arg);`, muted),
    canCall: (roomId: string): Promise<Availability> => onHook(page, `return hook.canCall(arg);`, roomId),
    deviceId: (): Promise<string> => page.evaluate(() => (window as any).__matrixPoc.getClient().getDeviceId()),
    /** `rtc.isMicrophoneEnabled` of the live LiveKit room when the hook exposes it, else `!activeCall.muted`. */
    micEnabled: (): Promise<boolean | null> =>
      onHook(page, `const r = hook.rtc ?? poc.rtc; const v = r?.isMicrophoneEnabled; if (typeof v === 'function') return await v(); if (typeof v === 'boolean') return v; const s = hook.state ? hook.state() : hook.store.getState(); return s.activeCall ? !s.activeCall.muted : null;`),
    /** Receiver stats per remote participant (`__matrixPoc.calls.stats()`). */
    stats: (): Promise<{ identity: string; bytesReceived: number; packetsReceived: number; decrypting: boolean }[]> => onHook(page, `return hook.stats ? await hook.stats() : [];`),
  };
}

/** Polls the store snapshot until `pred` holds; the failure message carries the last snapshot. */
export async function waitForCallState(page: Page, pred: (s: CallSnapshot) => boolean, message: string, timeout = 30_000): Promise<CallSnapshot> {
  const deadline = Date.now() + timeout;
  let last: CallSnapshot | null = null;
  let lastError: string | null = null;
  for (;;) {
    try {
      last = await callHook(page).state();
      lastError = null;
      if (pred(last)) return last;
    } catch (e) {
      lastError = String(e);
    }
    if (Date.now() > deadline) throw new Error(`${message}: not reached within ${timeout} ms\nlast state: ${JSON.stringify(last)}${lastError ? `\nlast evaluate error: ${lastError}` : ''}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const remoteOf = (s: CallSnapshot, user: string): CallParticipant | undefined => s.activeCall?.participants.find((p) => p.userId === user && !p.isSelf);

/** Both sides connected, every participant connected, the remote's key `ok` (the AC-R2-3 bar). */
export const connectedWith = (peer: string, count = 2) => (s: CallSnapshot): boolean =>
  s.activeCall?.state === 'connected' && s.activeCall.participants.length === count && s.activeCall.participants.every((p) => p.connected) && remoteOf(s, peer)?.keyState === 'ok';

/**
 * Short ring timeout for the 60 s cases, when the core exposes one (requested in docs/STATUS.md "Requests to Principal
 * (Phase 7)"). Returns the timeout now in force: `ms` when the override exists, else 60 000 (real time; budget it).
 */
export async function ringTimeoutOverride(page: Page, ms: number): Promise<number> {
  const applied = await onHook<boolean>(
    page,
    `const f = poc.call?.setRingTimeoutMs ?? poc.calls?.setRingTimeoutMs ?? hook.store?.getState?.().setRingTimeoutMs ?? poc.rtc?.setRingTimeoutMs; if (typeof f !== 'function') return false; await f(arg); return true;`,
    ms,
  ).catch(() => false);
  if (!applied) annotate('real-time', `no ring timeout override on __matrixPoc.calls (setRingTimeoutMs): the ${RING_LIFETIME_MS / 1000} s ring runs in real time`);
  return applied ? ms : RING_LIFETIME_MS;
}

// ---------------------------------------------------------------------------------------------- contexts

/** alice-2 / carol-as-third etc.: a desktop context logged in (closed by `e2eeAfterEach` unless closed earlier). */
export function thirdContext(browser: Browser, user: UserKey): Promise<SecondContext> {
  return secondContext(browser, user);
}

/** A phone context (Pixel 7, microphone granted) for the mobile spec's second device; logged in through the form. */
export async function mobileContext(browser: Browser, user: UserKey): Promise<SecondContext> {
  const ctx = await secondContext(browser, user, { login: false });
  await ctx.context.close();
  const context = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone'], baseURL: workerOrigin() });
  const page = await context.newPage();
  const { loginAs } = await import('./auth.ts');
  await loginAs(page, user);
  return { context, page, close: async () => context.close().catch(() => undefined) };
}

// ---------------------------------------------------------------------------------------------- cleanup

/** Every live (non-empty) `m.call` membership in `roomId`, from the room state as the server has it. */
export async function liveMemberships(roomId: string): Promise<{ stateKey: string; user: string; device: string; content: Record<string, unknown> }[]> {
  const api = await asUser('alice');
  const res = await fetch(`${V3}/rooms/${encodeURIComponent(roomId)}/state`, { headers: { authorization: `Bearer ${api.token}` } });
  if (!res.ok) return [];
  const state = (await res.json()) as { type: string; state_key: string; sender: string; content: Record<string, unknown> }[];
  return state
    .filter((e) => e.type === MEMBER_TYPE && Object.keys(e.content ?? {}).length > 0)
    .map((e) => {
      const m = /^_(@[^_]+:[^_]+)_(.+)_m\.call$/.exec(e.state_key);
      return { stateKey: e.state_key, user: m?.[1] ?? e.sender, device: m?.[2] ?? String(e.content.device_id ?? ''), content: e.content };
    });
}

const SEED_USERS: UserKey[] = ['alice', 'bob', 'carol', 'dave'];

/**
 * AC-R10-2: leave the call in every page given (store `leaveCall()`, best effort), then clear every live `m.call`
 * membership of a seeded user in `roomIds` by writing `{}` to its state key as that user. Run before and after each
 * test so a crashed run never starts the next one inside a stale call.
 */
export async function cleanupCalls(roomIds: string[], pages: Page[] = []): Promise<void> {
  for (const p of pages) {
    if (p.isClosed()) continue;
    await callHook(p).leave().catch(() => undefined);
  }
  for (const roomId of roomIds) {
    for (const m of await liveMemberships(roomId)) {
      const key = SEED_USERS.find((k) => userId(k) === m.user);
      if (!key) continue;
      const api = await asUser(key);
      await api.sendStateEvent(roomId, MEMBER_TYPE, m.stateKey, {}).catch(() => undefined);
    }
  }
}

/** Seeded rooms (public preset, `state_default: 50`) get the call event types at PL 0, as alice (their admin). */
export async function grantCallPowerLevels(roomId: string, as: UserKey = 'alice'): Promise<void> {
  const api = await asUser(as);
  const res = await fetch(`${V3}/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`, { headers: { authorization: `Bearer ${api.token}` } });
  const pl = (res.ok ? await res.json() : {}) as { events?: Record<string, number> };
  const events = { ...(pl.events ?? {}) };
  if (CALL_POWER_EVENTS.every((t) => events[t] === 0)) return;
  for (const t of CALL_POWER_EVENTS) events[t] = 0;
  await api.sendStateEvent(roomId, 'm.room.power_levels', '', { ...pl, events });
}

// ---------------------------------------------------------------------------------------------- network

/**
 * AC-R2-6: this page's outgoing Olm to-device messages (`PUT /sendToDevice/m.room.encrypted/*`, which carry the
 * `io.element.call.encryption_keys`) are swallowed with a 200 so the SDK believes they went out. Install before the
 * page joins. Returns `unblock()`.
 */
export async function blockMediaKeys(page: Page): Promise<() => Promise<void>> {
  const pattern = /\/_matrix\/client\/v3\/sendToDevice\/m\.room\.encrypted\//;
  const handler = (route: import('@playwright/test').Route): Promise<void> =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue();
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

// ---------------------------------------------------------------------------------------------- API caller

export interface ApiRing {
  ringEventId: string;
  membershipEventId: string | null;
  stateKey: string | null;
  from: string;
  /** Clears the fake membership ("the caller hung up"). */
  hangUp(): Promise<void>;
}

/** Content of a membership like the SDK's `joinRTCSession` sends (legacy session form, js-sdk 43). */
export function membershipContent(user: string, device: string, livekitServiceUrl: string): Record<string, unknown> {
  return {
    'application': 'm.call',
    'call_id': '',
    'scope': 'm.room',
    'device_id': device,
    'membershipID': `${user}:${device}`,
    'm.call.intent': 'audio',
    'focus_active': { type: 'livekit', focus_selection: 'oldest_membership' },
    'foci_preferred': [{ type: 'livekit', livekit_service_url: livekitServiceUrl }],
    'created_ts': Date.now(),
    'expires': 4 * 60 * 60 * 1000,
  };
}

/**
 * QA-34 `ringAlice`: rings through the API as `from` (default dave, the other member of the encrypted DM). Sends a
 * call membership for a fake device first (the ring watcher drops a ring whose caller has no membership: "caller
 * gone"), then the Codec ring content from docs/PHASE7_ACCEPTANCE.md "Wire shapes", referencing that membership.
 * Plaintext on the wire (the API cannot encrypt; the watcher reads plaintext events in encrypted rooms too).
 */
export async function ringAlice(
  roomId: string,
  opts: { from?: UserKey; userIds?: string[]; type?: 'ring' | 'notification' | string; senderTs?: number; lifetime?: number; membership?: boolean } = {},
): Promise<ApiRing> {
  const from = opts.from ?? 'dave';
  const api = await asUser(from);
  let membershipEventId: string | null = null;
  let stateKey: string | null = null;
  if (opts.membership !== false) {
    const device = `QARING${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    stateKey = memberStateKey(api.userId, device);
    membershipEventId = await api.sendStateEvent(roomId, MEMBER_TYPE, stateKey, membershipContent(api.userId, device, (await focusUrl()) ?? 'http://localhost:7980'));
  }
  const ringEventId = await api.sendEvent(roomId, RING_TYPE, {
    'slot_id': 'm.call#ROOM',
    'notification_type': opts.type ?? 'ring',
    'm.call.intent': 'audio',
    'sender_ts': opts.senderTs ?? Date.now(),
    'lifetime': opts.lifetime ?? RING_LIFETIME_MS,
    'm.mentions': { user_ids: opts.userIds ?? [userId('alice')] },
    ...(membershipEventId ? { 'm.relates_to': { rel_type: 'm.reference', event_id: membershipEventId } } : {}),
  });
  return {
    ringEventId,
    membershipEventId,
    stateKey,
    from: api.userId,
    async hangUp() {
      if (stateKey) await api.sendStateEvent(roomId, MEMBER_TYPE, stateKey, {});
    },
  };
}

/** A `dev.matrixpoc.call` line through the API (plaintext), e.g. `{ kind: 'ended', call_id, duration_ms: 720000 }`. */
export async function sendCallLine(roomId: string, as: UserKey, content: Record<string, unknown>): Promise<string> {
  return (await asUser(as)).sendEvent(roomId, LINE_TYPE, content);
}

/** An MSC4310 decline through the API, as js-sdk 43 shapes it (+ the Codec busy marker). */
export async function sendDeclineApi(roomId: string, as: UserKey, ringEventId: string, busy = false): Promise<string> {
  return (await asUser(as)).sendEvent(roomId, DECLINE_TYPE, {
    'm.relates_to': { rel_type: 'm.reference', event_id: ringEventId },
    'msc4354_sticky_key': ringEventId,
    ...(busy ? { [DECLINE_REASON_KEY]: 'busy' } : {}),
  });
}

// ---------------------------------------------------------------------------------------------- reading events

export interface ClearEvent {
  eventId: string;
  type: string;
  sender: string;
  ts: number;
  content: Record<string, unknown>;
  /** The type on the wire (`m.room.encrypted` for an encrypted event). */
  wireType: string;
}

/**
 * Decrypted call events (ring, decline, `dev.matrixpoc.call`) in the page's live timeline, oldest first. The API
 * cannot decrypt, so content assertions go through the page's own SDK; `expectSentEncrypted` checks the wire.
 */
export async function callEventsInPage(page: Page, roomId: string): Promise<ClearEvent[]> {
  return page.evaluate(
    ([rid, types]) => {
      const room = (window as any).__matrixPoc.getClient().getRoom(rid);
      if (!room) return [];
      return room
        .getLiveTimeline()
        .getEvents()
        .filter((e: any) => types.includes(e.getType()))
        .map((e: any) => ({ eventId: e.getId(), type: e.getType(), sender: e.getSender(), ts: e.getTs(), content: JSON.parse(JSON.stringify(e.getContent())), wireType: e.getWireType?.() ?? e.event?.type }));
    },
    [roomId, [RING_TYPE, DECLINE_TYPE, LINE_TYPE]] as [string, string[]],
  );
}

/** The call events after `sinceTs`, of `type` (and kind for lines). */
export async function callEventsSince(page: Page, roomId: string, sinceTs: number, type: string, kind?: string): Promise<ClearEvent[]> {
  return (await callEventsInPage(page, roomId)).filter((e) => e.ts >= sinceTs - 2000 && e.type === type && (kind === undefined || e.content.kind === kind));
}

/** Room events as the server stores them (no decryption), newest first. */
export async function wireEventsSince(roomId: string, sinceTs: number): Promise<{ event_id: string; type: string; sender: string; origin_server_ts: number; content: Record<string, unknown> }[]> {
  const api = await asUser('alice');
  const res = await fetch(`${V3}/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`, { headers: { authorization: `Bearer ${api.token}` } });
  const body = (await res.json()) as { chunk: { event_id: string; type: string; sender: string; origin_server_ts: number; content: Record<string, unknown> }[] };
  return body.chunk.filter((e) => e.origin_server_ts >= sinceTs - 2000);
}

/** A Codec-sent call event in an encrypted room is `m.room.encrypted` on the wire. */
export async function expectSentEncrypted(roomId: string, eventId: string): Promise<void> {
  const api = await asUser('alice');
  const res = await fetch(`${V3}/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, { headers: { authorization: `Bearer ${api.token}` } });
  const ev = (await res.json()) as { type: string };
  expect(ev.type, `${eventId} is encrypted on the wire`).toBe('m.room.encrypted');
}

// ---------------------------------------------------------------------------------------------- page stubs

/** `navigator.vibrate` stub recording every call in `window.__qaVibrate` (install before the first navigation). */
export async function stubVibrate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __qaVibrate: unknown[] };
    w.__qaVibrate = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p: unknown) => (w.__qaVibrate.push(p), true) });
  });
}

export const vibrateCalls = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as unknown as { __qaVibrate?: unknown[] }).__qaVibrate ?? []);

/**
 * AC-R9-1: replaces the speakerphone shim (`__matrixPoc.calls.rtc.setSpeakerphone`, or `__matrixPoc.rtc.…`) with a
 * recorder. Returns false when no such shim exists yet (the caller annotates).
 */
export async function stubSpeakerphone(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const poc = (window as any).__matrixPoc;
    const w = window as unknown as { __qaSpeaker: unknown[] };
    w.__qaSpeaker = [];
    let stubbed = false;
    for (const target of [poc?.calls?.rtc, poc?.call?.rtc, poc?.rtc]) {
      if (target && typeof target.setSpeakerphone === 'function') {
        try {
          target.setSpeakerphone = (on: unknown) => (w.__qaSpeaker.push(on), Promise.resolve());
          stubbed = true;
        } catch {
          /* frozen ES module namespace: cannot stub here */
        }
      }
    }
    return stubbed;
  });
}

export const speakerCalls = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as unknown as { __qaSpeaker?: unknown[] }).__qaSpeaker ?? []);

// ---------------------------------------------------------------------------------------------- UI shorthands

export const callScreen = (page: Page): Locator => page.getByTestId('call-screen');
export const incomingCard = (page: Page): Locator => page.getByTestId('incoming-call');
export const participantTile = (page: Page, user: string): Locator => page.getByTestId(`call-participant-${user}`);
export const callLines = (page: Page, kind?: string): Locator => page.locator(kind ? `[data-testid="message-call"][data-kind="${kind}"]` : '[data-testid="message-call"]');

/** `mm:ss` of `call-timer` (or of the in-call bar text) in seconds. */
export function parseClock(text: string): number {
  const m = /(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export { PASSWORD };
