/**
 * Session store: who is logged in and where we are in the login -> sync -> ready lifecycle.
 *
 * status flow:
 *   'logged-out' --login()--> 'logging-in' --> 'syncing' --> 'ready'
 *   'logged-out' --restore() (stored session)--> 'syncing' --> 'ready'
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
  logout as sdkLogout,
  register as sdkRegister,
  startClientFromSession,
  waitForPrepared,
  type StoredSession,
} from '@/lib/matrix/client.ts';
import { HS_URL } from '@/lib/matrix/config.ts';
import { bindClient, unbindClient } from './bridge.ts';
import { resetRooms } from './rooms.ts';
import { resetTimelines } from './timeline.ts';

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
  login(username: string, password: string): Promise<void>;
  register(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Restore a persisted session on page load. No-op when nothing is stored. */
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
  if (e instanceof ConnectionError) return `Cannot reach the homeserver at ${HS_URL}`;
  if (e instanceof Error) {
    if (/fetch|network/i.test(e.message)) return `Cannot reach the homeserver at ${HS_URL}`;
    return e.message;
  }
  return String(e);
}

const initialSession = loadSession();

export const useSessionStore = create<SessionState>((set, get) => {
  async function startSession(session: StoredSession): Promise<void> {
    set({ status: 'syncing', userId: session.userId, error: null });
    const client = await startClientFromSession(session, {
      onSyncState: (state: SyncState, _prev: SyncState | null, data?: ISyncStateData) => {
        set({ syncState: state });
        if (state === SyncState.Error && get().status === 'ready') {
          set({ error: describeError(data?.error) });
        } else if (state === SyncState.Syncing && get().status === 'ready') {
          set({ error: null });
        }
      },
    });
    bindClient(client, { onSessionLoggedOut: () => void get().logout() });
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
    set({ status: 'ready', displayName, avatarUrl, error: null });
  }

  async function fail(e: unknown, nextStatus: SessionStatus): Promise<void> {
    const message = describeError(e);
    unbindClient();
    await sdkLogout();
    resetRooms();
    resetTimelines();
    set({ status: nextStatus, userId: null, displayName: null, avatarUrl: null, error: message, syncState: null });
  }

  return {
    status: initialSession ? 'syncing' : 'logged-out',
    userId: initialSession?.userId ?? null,
    displayName: null,
    avatarUrl: null,
    error: null,
    syncState: null,

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

    async restore() {
      const session = loadSession();
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
    },

    async logout() {
      unbindClient();
      await sdkLogout();
      resetRooms();
      resetTimelines();
      set({ status: 'logged-out', userId: null, displayName: null, avatarUrl: null, error: null, syncState: null });
    },
  };
});
