/**
 * MatrixClient lifecycle: create / restore / login / register / logout + session persistence.
 * Owned by the Principal. Devs consume `getClient()` and the stores; they never call
 * `startClient` or construct clients themselves.
 *
 * No crypto is ever initialised (E2EE is out of scope); every room is created unencrypted.
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
import { DEVICE_DISPLAY_NAME, HS_URL, SESSION_STORAGE_KEY } from './config.ts';

export { mxcToHttp } from './mxc.ts';

export interface StoredSession {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

let client: MatrixClient | null = null;

/** The live, started client. Throws when nobody is logged in. */
export function getClient(): MatrixClient {
  if (!client) throw new Error('Matrix client not initialised: nobody is logged in');
  return client;
}

/** Same as getClient() but returns null instead of throwing. */
export function getClientOrNull(): MatrixClient | null {
  return client;
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
    return { baseUrl: s.baseUrl || HS_URL, userId: s.userId, accessToken: s.accessToken, deviceId: s.deviceId };
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
  const tmp = createClient({ baseUrl: HS_URL });
  const res = await tmp.login('m.login.password', {
    identifier: { type: 'm.id.user', user: username.trim() },
    password,
    initial_device_display_name: DEVICE_DISPLAY_NAME,
  });
  const session: StoredSession = {
    baseUrl: HS_URL,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
  saveSession(session);
  return session;
}

/** Open registration with the dummy UIA stage (homeserver has enable_registration_without_verification). */
export async function register(username: string, password: string): Promise<StoredSession> {
  const tmp = createClient({ baseUrl: HS_URL });
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
    baseUrl: HS_URL,
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
}

/**
 * Create the client for a session and start syncing. Resolves once the client is created and
 * `startClient` has been called; use `waitForPrepared()` to wait for the first sync.
 */
export async function startClientFromSession(session: StoredSession, opts: StartOptions = {}): Promise<MatrixClient> {
  if (client) {
    await teardownClient(client);
    client = null;
  }
  const c = createClient({
    baseUrl: session.baseUrl,
    userId: session.userId,
    accessToken: session.accessToken,
    deviceId: session.deviceId,
    timelineSupport: true,
  });
  if (opts.onSyncState) c.on(ClientEvent.Sync, opts.onSyncState);
  client = c;
  await c.startClient({
    initialSyncLimit: 30,
    lazyLoadMembers: true,
    pendingEventOrdering: PendingEventOrdering.Chronological,
    // No threads (out of scope) and no crypto.
    threadSupport: false,
  });
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

async function teardownClient(c: MatrixClient): Promise<void> {
  try {
    c.stopClient();
  } catch {
    /* ignore */
  }
  c.removeAllListeners();
  try {
    await c.store.destroy();
  } catch {
    /* ignore */
  }
}

/**
 * Log out: best-effort server-side logout, stop syncing, drop the client, clear localStorage.
 * Never throws.
 */
export async function logout(): Promise<void> {
  const c = client;
  client = null;
  clearSession();
  if (!c) return;
  try {
    await c.logout(true);
  } catch {
    /* token may already be invalid; ignore */
  }
  await teardownClient(c);
}
