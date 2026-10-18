/**
 * The call feature's app-level mount (the shell renders `<CallHost />` once inside `call-host`, desktop and
 * phone): the incoming card, the call screen, and the toast for a failed start / accept / join (store
 * `lastError`, e.g. the microphone was denied). `InCallBar` is not here: `Conversation` places it next to the
 * composer.
 */
import { useEffect } from 'react';
import { useCallError, useCallStore } from '@/store/call.ts';
import { showToast } from '@/store/toast.ts';
import { errorText } from './model.ts';
import { IncomingCallCard } from './IncomingCallCard.tsx';
import { CallScreen } from './CallScreen.tsx';

export function CallHost() {
  return (
    <>
      <CallErrorToast />
      <CallScreen />
      <IncomingCallCard />
    </>
  );
}

export function CallErrorToast() {
  const error = useCallError();
  useEffect(() => {
    if (!error) return;
    showToast(errorText(error.code, error.message), 'error');
    useCallStore.getState().clearError();
  }, [error]);
  return null;
}
