/**
 * Navigation feature (Dev A). The shell mounts exactly these four components and passes nothing
 * but `roomId` where needed. Keep the names and props stable; change the internals freely.
 */
export { SpaceRail } from './components/SpaceRail.tsx';
export { ChannelSidebar } from './components/ChannelSidebar.tsx';
export { ChannelHeader } from './components/ChannelHeader.tsx';
export { MemberPanel } from './components/MemberPanel.tsx';
export { useNavUiStore } from './state.ts';
