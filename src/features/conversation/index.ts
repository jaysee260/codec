/**
 * Conversation feature (Dev B). The shell mounts `<Conversation roomId />` under the channel header and,
 * while a thread is open, `<ThreadView roomId rootId />` in the thread panel container (Phase 3).
 * Keep the names and props stable; change the internals freely.
 */
export { Conversation } from './components/Conversation.tsx';
export { ThreadView } from './components/ThreadView.tsx';
