/**
 * Navigation feature (Dev A). The shell mounts exactly these four components and passes nothing
 * but `roomId` where needed. Keep the names and props stable; change the internals freely.
 */
export { SpaceRail } from './components/SpaceRail.tsx';
export { ChannelSidebar } from './components/ChannelSidebar.tsx';
export { ChannelHeader } from './components/ChannelHeader.tsx';
export { MemberPanel } from './components/MemberPanel.tsx';
export { useNavUiStore } from './state.ts';
/** Shared modal / bottom sheet, reused by `@/features/security` (Phase 5). */
export { Dialog, DialogField, type DialogProps } from './components/Dialog.tsx';
