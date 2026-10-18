/**
 * MatrixClient lifecycle: create / restore / login / register / logout + session persistence.
 * Owned by the Principal. Devs consume `getClient()` and the stores; they never call
 * `startClient` or construct clients themselves.
 *
 * Phase 5: the Rust crypto engine starts between `createClient` and `startClient` (`crypto.ts`), with an
 * IndexedDB store per user+device so keys survive reloads; logout and a rejected token wipe that store.
 */
import {
  createClient,
  ClientEvent,
  HttpApiEvent,
  PendingEventOrdering,
  SyncState,
  type MatrixClient,
} from 'matrix-js-sdk';
import type { ISyncStateData } from 'matrix-js-sdk/lib/sync.js';
import { DEVICE_DISPLAY_NAME, getHsUrl, SESSION_STORAGE_KEY } from './config.ts';
import { clearSecretStorageKeyCache, cryptoCallbacks, initCrypto, VERIFICATION_METHODS, wipeCryptoStore } from './crypto.ts';
import { probeAuthenticatedMedia } from './media.ts';

export { mxcToHttp } from './mxc.ts';
export { getCryptoError, cryptoDatabasePrefix } from './crypto.ts';

export interface StoredSession {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

let client: MatrixClient | null = null;
/** The session the live client was started from (for the crypto store prefix on teardown). */
let clientSession: StoredSession | null = null;

/** The live, started client. Throws when nobody is logged in. */
export function getClient(): MatrixClient {
  if (!client) throw new Error('Matrix client not initialised: nobody is logged in');
  return client;
}

/** Same as getClient() but returns null instead of throwing. */
export function getClientOrNull(): MatrixClient | null {
  return client;
}

/** The session behind the live client, or null. */
export function getCurrentSession(): StoredSession | null {
  return clientSession;
}

// ---------------------------------------------------------------------------
// Session persistence (localStorage)
// ---------------------------------------------------------------------------

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (!s.userId || !s.accessToken || !s.deviceId) return null;
    return { baseUrl: s.baseUrl || getHsUrl(), userId: s.userId, accessToken: s.accessToken, deviceId: s.deviceId };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Password login. Resolves with the session (already persisted). Throws MatrixError on failure. */
export async function login(username: string, password: string): Promise<StoredSession> {
  const baseUrl = getHsUrl();
  const tmp = createClient({ baseUrl });
  const res = await tmp.login('m.login.password', {
    identifier: { type: 'm.id.user', user: username.trim() },
    password,
    initial_device_display_name: DEVICE_DISPLAY_NAME,
  });
  const session: StoredSession = {
    baseUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
  saveSession(session);
  return session;
}

/** An SSO identity provider offered by the homeserver (e.g. Keycloak). `id` is '' when the server lists none. */
export interface SsoProvider {
  id: string;
  name: string;
}

/** What the login screen can offer on a homeserver: password login, SSO providers, open registration. */
export interface LoginOptions {
  password: boolean;
  sso: SsoProvider[];
  registration: boolean;
}

/**
 * Ask the homeserver which login methods it accepts (`GET /login`) and whether registration is open
 * (`POST /register` with an empty body: 401 with flows when open, 403 when disabled; no account is created).
 * Network errors fall back to password-only, so the form still shows when the server is unreachable.
 */
export async function getLoginOptions(baseUrl: string): Promise<LoginOptions> {
  const tmp = createClient({ baseUrl });
  let password = true;
  let sso: SsoProvider[] = [];
  try {
    const { flows } = await tmp.loginFlows();
    password = flows.some((f) => f.type === 'm.login.password');
    for (const f of flows) {
      if (f.type !== 'm.login.sso') continue;
      const idps = (f as { identity_providers?: { id: string; name: string }[] }).identity_providers;
      sso = idps?.length ? idps.map((p) => ({ id: p.id, name: p.name })) : [{ id: '', name: 'Single sign-on' }];
    }
  } catch {
    return { password: true, sso: [], registration: true };
  }
  // Registration here means the password form, so it is only offered alongside password login.
  let registration = false;
  if (password) {
    try {
      const res = await fetch(`${baseUrl}/_matrix/client/v3/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      registration = res.status === 401;
    } catch {
      registration = true; // unreachable: keep the classic form
    }
  }
  return { password, sso, registration };
}

/** Query parameter Synapse appends to the redirect URL after SSO. */
const LOGIN_TOKEN_PARAM = 'loginToken';

/** Where to send the browser to sign in with `provider`; the homeserver redirects back here with a login token. */
export function ssoRedirectUrl(baseUrl: string, provider: SsoProvider): string {
  const back = new URL(window.location.href);
  back.searchParams.delete(LOGIN_TOKEN_PARAM);
  return createClient({ baseUrl }).getSsoLoginUrl(back.toString(), 'sso', provider.id || undefined);
}

/** Remove and return the SSO login token from the current URL, or null when there is none. */
export function takeLoginTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get(LOGIN_TOKEN_PARAM);
  if (!token) return null;
  url.searchParams.delete(LOGIN_TOKEN_PARAM);
  window.history.replaceState(window.history.state, '', url.toString());
  return token;
}

/** Finish an SSO login: exchange the one-time login token for a session (already persisted). */
export async function loginWithToken(token: string): Promise<StoredSession> {
  const baseUrl = getHsUrl();
  const tmp = createClient({ baseUrl });
  const res = await tmp.login('m.login.token', { token, initial_device_display_name: DEVICE_DISPLAY_NAME });
  const session: StoredSession = {
    baseUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
  saveSession(session);
  return session;
}

/** Open registration with the dummy UIA stage (homeserver has enable_registration_without_verification). */
export async function register(username: string, password: string): Promise<StoredSession> {
  const baseUrl = getHsUrl();
  const tmp = createClient({ baseUrl });
  const res = await tmp.registerRequest({
    username: username.trim(),
    password,
    auth: { type: 'm.login.dummy' },
    initial_device_display_name: DEVICE_DISPLAY_NAME,
    inhibit_login: false,
  });
  if (!res.access_token || !res.device_id) {
    // Server chose not to log us in on register; fall back to a normal login.
    return login(username, password);
  }
  const session: StoredSession = {
    baseUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
  saveSession(session);
  return session;
}

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

export interface StartOptions {
  /** Called on every sync state change (the store uses this to surface errors). */
  onSyncState?: (state: SyncState, prev: SyncState | null, data?: ISyncStateData) => void;
  /** Phase 5: called while the crypto engine loads (WASM download + IndexedDB open), for the loading screen. */
  onCryptoLoading?: () => void;
}

/**
 * Create the client for a session, start the crypto engine, and start syncing. Resolves once `startClient`
 * has been called; use `waitForPrepared()` to wait for the first sync.
 *
 * Phase 5: `initRustCrypto` runs between `createClient` and `startClient` (the SDK requires that order) with
 * `cryptoDatabasePrefix(session)`, so the device's keys persist across reloads. A crypto failure does not block
 * login: the client runs without encryption and `getCryptoError()` says why (see crypto.ts).
 */
export async function startClientFromSession(session: StoredSession, opts: StartOptions = {}): Promise<MatrixClient> {
  if (client) {
    // Switching sessions without a logout (e.g. a second SSO return): stop the old client but keep its store;
    // its device is still valid server-side and would reuse the same prefix if it ever came back.
    await teardownClient(client);
    client = null;
    clientSession = null;
  }
  const c = createClient({
    baseUrl: session.baseUrl,
    userId: session.userId,
    accessToken: session.accessToken,
    deviceId: session.deviceId,
    timelineSupport: true,
    // Phase 5: the SDK asks these for the recovery key whenever it touches secret storage (crypto.ts).
    cryptoCallbacks,
    verificationMethods: VERIFICATION_METHODS,
  });
  if (opts.onSyncState) c.on(ClientEvent.Sync, opts.onSyncState);
  // Runs alongside the first sync; nothing renders media before the client is prepared.
  const mediaProbe = probeAuthenticatedMedia(session.baseUrl);
  client = c;
  clientSession = session;
  opts.onCryptoLoading?.();
  await initCrypto(c, session);
  await c.startClient({
    initialSyncLimit: 30,
    lazyLoadMembers: true,
    pendingEventOrdering: PendingEventOrdering.Chronological,
    // Phase 3: threads. In matrix-js-sdk v43 this is a startClient option (not createClient). It makes the
    // SDK partition `m.thread` replies out of the main live timeline into `room.getThread(rootId)` models,
    // add `thread_id` to read receipts, and request `unread_thread_notifications` in the sync filter.
    threadSupport: true,
  });
  await mediaProbe;
  return c;
}

/**
 * Resolve when the initial sync is done (SyncState.Prepared). Rejects if the access token is
 * rejected by the server (M_UNKNOWN_TOKEN / session logged out). Transient sync errors are
 * reported through `onError` and the SDK keeps retrying.
 */
export function waitForPrepared(c: MatrixClient, onError?: (message: string) => void): Promise<void> {
  if (c.isInitialSyncComplete()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      c.off(ClientEvent.Sync, onSync);
      c.off(HttpApiEvent.SessionLoggedOut, onLoggedOut);
    };
    const onSync = (state: SyncState, _prev: SyncState | null, data?: ISyncStateData): void => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        cleanup();
        resolve();
      } else if (state === SyncState.Error) {
        const err = data?.error as { errcode?: string; message?: string } | undefined;
        if (err?.errcode === 'M_UNKNOWN_TOKEN') {
          cleanup();
          reject(new Error('Session expired, please log in again'));
        } else {
          onError?.(err?.message ?? 'Cannot reach the homeserver, retrying...');
        }
      }
    };
    const onLoggedOut = (): void => {
      cleanup();
      reject(new Error('Session logged out by the server'));
    };
    c.on(ClientEvent.Sync, onSync);
    c.on(HttpApiEvent.SessionLoggedOut, onLoggedOut);
  });
}

/**
 * Stop a client. With `wipe`, also delete its crypto store (must happen after `stopClient`: the SDK refuses to
 * clear stores while running, and two engines on one IndexedDB corrupt it).
 */
async function teardownClient(c: MatrixClient, wipe?: StoredSession | null): Promise<void> {
  try {
    c.stopClient();
  } catch {
    /* ignore */
  }
  c.removeAllListeners();
  if (wipe) await wipeCryptoStore(c, wipe);
  try {
    await c.store.destroy();
  } catch {
    /* ignore */
  }
}

/**
 * Log out: best-effort server-side logout, stop syncing, drop the client, clear localStorage, and delete the
 * device's crypto store (Phase 5: the device is gone server-side, its keys must not outlive it). Never throws.
 */
export async function logout(): Promise<void> {
  const c = client;
  const session = clientSession;
  client = null;
  clientSession = null;
  clearSession();
  clearSecretStorageKeyCache();
  if (!c) return;
  try {
    await c.logout(true);
  } catch {
    /* token may already be invalid; ignore */
  }
  await teardownClient(c, session);
}
