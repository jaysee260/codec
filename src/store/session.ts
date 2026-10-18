/**
 * Session store: who is logged in and where we are in the login -> sync -> ready lifecycle.
 *
 * status flow:
 *   'logged-out' --login()--> 'logging-in' --> 'syncing' --> 'ready'
 *   'logged-out' --restore() (stored session)--> 'syncing' --> 'ready'
 *   page load with ?loginToken= (back from SSO) --restore()--> 'logging-in' --> 'syncing' --> 'ready'
 *   any failure during login/register --> 'error' (login form shows `error`)
 *   logout() --> 'logged-out'
 */
import { create } from 'zustand';
import { ConnectionError, MatrixError, SyncState } from 'matrix-js-sdk';
import type { ISyncStateData } from 'matrix-js-sdk/lib/sync.js';
import {
  getClientOrNull,
  loadSession,
  login as sdkLogin,
  loginWithToken as sdkLoginWithToken,
  logout as sdkLogout,
  register as sdkRegister,
  startClientFromSession,
  takeLoginTokenFromUrl,
  waitForPrepared,
  type StoredSession,
} from '@/lib/matrix/client.ts';
import { getHsUrl } from '@/lib/matrix/config.ts';
import { clearLinkPreviewCache } from '@/lib/preview/fetch.ts';
import { bindClient, unbindClient } from './bridge.ts';
import { resetRooms } from './rooms.ts';
import { bindSecurity, resetSecurity, unbindSecurity } from './security.ts';
import { bindCalls, resetCalls, unbindCalls } from './call.ts';
import { resetTimelines } from './timeline.ts';
import { resetThreads } from './threads.ts';

export type SessionStatus = 'logged-out' | 'logging-in' | 'syncing' | 'ready' | 'error';

export interface SessionState {
  status: SessionStatus;
  userId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** Human-readable error for the login form / loading screen. */
  error: string | null;
  /** Last SDK sync state (for a "reconnecting" hint in the shell). */
  syncState: SyncState | null;
  /** Phase 5: what the loading screen is waiting on ('crypto' = WASM + key store, then 'sync'). */
  loadingStage: 'crypto' | 'sync' | null;
  login(username: string, password: string): Promise<void>;
  register(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Restore a persisted session on page load, or finish an SSO login. No-op when there is neither. */
  restore(): Promise<void>;
}

export function describeError(e: unknown): string {
  if (e instanceof MatrixError) {
    switch (e.errcode) {
      case 'M_FORBIDDEN':
        return 'Invalid username or password';
      case 'M_USER_IN_USE':
        return 'That username is already taken';
      case 'M_INVALID_USERNAME':
        return 'Invalid username (use letters, digits, . _ = - /)';
      case 'M_WEAK_PASSWORD':
        return 'Password is too weak';
      case 'M_LIMIT_EXCEEDED':
        return 'Too many attempts, please wait a moment';
      case 'M_UNKNOWN_TOKEN':
        return 'Session expired, please log in again';
      default:
        return (e.data as { error?: string } | undefined)?.error ?? e.message;
    }
  }
  if (e instanceof ConnectionError) return `Cannot reach the homeserver at ${getHsUrl()}`;
  if (e instanceof Error) {
    if (/fetch|network/i.test(e.message)) return `Cannot reach the homeserver at ${getHsUrl()}`;
    return e.message;
  }
  return String(e);
}

const initialSession = loadSession();

/** The in-flight restore(): React StrictMode runs the boot effect twice, and both calls must share one start. */
let restoring: Promise<void> | null = null;

export const useSessionStore = create<SessionState>((set, get) => {
  async function startSession(session: StoredSession): Promise<void> {
    set({ status: 'syncing', userId: session.userId, error: null, loadingStage: 'crypto' });
    const client = await startClientFromSession(session, {
      onSyncState: (state: SyncState, _prev: SyncState | null, data?: ISyncStateData) => {
        set({ syncState: state });
        if (state === SyncState.Error && get().status === 'ready') {
          set({ error: describeError(data?.error) });
        } else if (state === SyncState.Syncing && get().status === 'ready') {
          set({ error: null });
        }
      },
      onCryptoLoading: () => set({ loadingStage: 'crypto' }),
    });
    set({ loadingStage: 'sync' });
    // BUG-11 / AC-E1-4: a token rejected after boot (device deleted, M_UNKNOWN_TOKEN) wipes like a logout *and*
    // tells the user why on the login form (`fail` keeps the message; `logout()` clears it).
    bindClient(client, { onSessionLoggedOut: () => void fail(new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'Session expired' }), 'error') });
    bindSecurity(client);
    bindCalls(client); // Phase 7: ring watcher + live-session tracking
    await waitForPrepared(client, (message) => set({ error: message }));
    // Profile: cheap request, avoids depending on lazy-loaded member events.
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    try {
      const profile = await client.getProfileInfo(session.userId);
      displayName = profile.displayname ?? null;
      avatarUrl = profile.avatar_url ?? null;
    } catch {
      /* profile is optional */
    }
    set({ status: 'ready', displayName, avatarUrl, error: null, loadingStage: null });
  }

  async function fail(e: unknown, nextStatus: SessionStatus): Promise<void> {
    const message = describeError(e);
    resetCalls(); // Phase 7: hang up before the client stops
    unbindCalls();
    unbindSecurity();
    unbindClient();
    await sdkLogout(); // Phase 5: also wipes the device's crypto store (the token / device is gone)
    resetRooms();
    resetTimelines();
    resetThreads();
    resetSecurity();
    clearLinkPreviewCache(); // Phase 6: the next user in this browser must not inherit cached previews
    set({ status: nextStatus, userId: null, displayName: null, avatarUrl: null, error: message, syncState: null, loadingStage: null });
  }

  async function doRestore(): Promise<void> {
    const ssoToken = takeLoginTokenFromUrl();
    let tokenError: string | null = null;
    if (ssoToken) {
      set({ status: 'logging-in', error: null });
      let fresh: StoredSession | null = null;
      try {
        fresh = await sdkLoginWithToken(ssoToken);
      } catch (e) {
        // Expired or reused token (e.g. Back after signing in): keep any stored session and say so plainly.
        tokenError =
          e instanceof MatrixError && e.errcode === 'M_FORBIDDEN' ? 'That sign-in expired, please try again' : describeError(e);
      }
      if (fresh) {
        try {
          await startSession(fresh);
        } catch (e) {
          await fail(e, 'error');
        }
        return;
      }
    }
    const session = loadSession();
    if (!session && tokenError) {
      set({ status: 'error', error: tokenError });
      return;
    }
    if (!session) {
      if (get().status === 'syncing') set({ status: 'logged-out' });
      return;
    }
    if (getClientOrNull()) return; // already started (React StrictMode double-invokes effects)
    try {
      await startSession(session);
    } catch (e) {
      await fail(e, 'logged-out');
    }
  }

  return {
    status: initialSession ? 'syncing' : 'logged-out',
    userId: initialSession?.userId ?? null,
    displayName: null,
    avatarUrl: null,
    error: null,
    syncState: null,
    loadingStage: initialSession ? 'crypto' : null,

    async login(username, password) {
      if (get().status === 'logging-in' || get().status === 'syncing') return;
      set({ status: 'logging-in', error: null });
      try {
        const session = await sdkLogin(username, password);
        await startSession(session);
      } catch (e) {
        await fail(e, 'error');
      }
    },

    async register(username, password) {
      if (get().status === 'logging-in' || get().status === 'syncing') return;
      set({ status: 'logging-in', error: null });
      try {
        const session = await sdkRegister(username, password);
        await startSession(session);
      } catch (e) {
        await fail(e, 'error');
      }
    },

    restore() {
      restoring ??= doRestore().finally(() => {
        restoring = null;
      });
      return restoring;
    },

    async logout() {
      resetCalls(); // Phase 7: hang up before the client stops
      unbindCalls();
      unbindSecurity();
      unbindClient();
      await sdkLogout(); // Phase 5: wipes the crypto store too
      resetRooms();
      resetTimelines();
      resetThreads();
      resetSecurity();
      clearLinkPreviewCache(); // Phase 6: same on explicit logout
      set({ status: 'logged-out', userId: null, displayName: null, avatarUrl: null, error: null, syncState: null, loadingStage: null });
    },
  };
});
