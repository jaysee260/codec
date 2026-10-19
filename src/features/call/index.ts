/**
 * Call feature (Dev B, Phase 7: voice calls). Dev A mounts `<CallButton roomId />` in the channel header; the
 * shell mounts `<CallHost />` (incoming card + call screen + error toast) once in `call-host`. `InCallBar` is
 * mounted by `Conversation` (above the composer / top of the conversation on phone); it is exported for
 * completeness, mount it only once. `IncomingCallCard` / `CallScreen` are exported for a shell that mounts
 * the pieces itself instead of `CallHost`.
 */
export { CallButton } from './CallButton.tsx';
export { CallHost, CallErrorToast } from './CallHost.tsx';
export { IncomingCallCard } from './IncomingCallCard.tsx';
export { CallScreen } from './CallScreen.tsx';
export { InCallBar } from './InCallBar.tsx';
export { useCallUi, startCallFromUi, ringModeFor } from './useCallUi.ts';
