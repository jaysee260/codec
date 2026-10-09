/**
 * Session gate: login screen <-> loading <-> shell.
 * 'logged-out' | 'logging-in' | 'error' -> <LoginScreen/>
 * 'syncing'                             -> <LoadingScreen/> (data-testid="app-loading")
 * 'ready'                               -> <Shell/>         (data-testid="app-shell")
 *
 * Phase 2: also boots the native integration (status bar, keyboard, Android back button) and, in dev
 * builds only, exposes the stores on `window.__matrixPoc` for scripts (see devtools.ts).
 * Phase 3: Android back closes an open thread first, then an open drawer, then minimises the app.
 */
import { useEffect } from 'react';
import { useSessionStore } from '@/store/session.ts';
import { runBackHandlers, useLayoutStore } from '@/store/layout.ts';
import { useThreadStore } from '@/store/threads.ts';
import { initNative } from '@/lib/native.ts';
import { LoginScreen } from './LoginScreen.tsx';
import { LoadingScreen } from './LoadingScreen.tsx';
import { Shell } from './Shell.tsx';
import { Toast } from './Toast.tsx';
import { installDevHooks } from './devtools.ts';

export function App() {
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
    if (import.meta.env.DEV) installDevHooks();
    void initNative({
      onKeyboard: (height) => useLayoutStore.getState().setKeyboardHeight(height),
      // Android back: registered feature handlers first (Phase 4: the GIF sheet), then an open thread, else an open
      // drawer; otherwise initNative minimises the app (docs/PHASE3_TICKETS.md PRIN-10: thread -> sheets/drawers -> minimizeApp).
      onBackButton: () => runBackHandlers() || useThreadStore.getState().closeThread() || useLayoutStore.getState().closeDrawers(),
    });
    void useSessionStore.getState().restore();
  }, []);

  let screen: React.ReactNode;
  if (status === 'ready') screen = <Shell />;
  else if (status === 'syncing') screen = <LoadingScreen />;
  else screen = <LoginScreen />;

  return (
    <>
      {screen}
      <Toast />
    </>
  );
}
