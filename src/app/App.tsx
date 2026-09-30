/**
 * Session gate: login screen <-> loading <-> shell.
 * 'logged-out' | 'logging-in' | 'error' -> <LoginScreen/>
 * 'syncing'                             -> <LoadingScreen/> (data-testid="app-loading")
 * 'ready'                               -> <Shell/>         (data-testid="app-shell")
 */
import { useEffect } from 'react';
import { useSessionStore } from '@/store/session.ts';
import { LoginScreen } from './LoginScreen.tsx';
import { LoadingScreen } from './LoadingScreen.tsx';
import { Shell } from './Shell.tsx';
import { Toast } from './Toast.tsx';

export function App() {
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
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
