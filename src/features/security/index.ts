/**
 * Security feature (Dev A, Phase 5): the encryption banner and the verify / unlock / setup dialogs. The Shell
 * mounts `SecurityBanner` (in `security-banner-host`) and `SecurityDialogs` (in `security-dialogs-host`) lazily;
 * other features open a dialog with `openSecurityDialog('setup' | 'verify' | 'unlock')`.
 * Reads only `useSecurityStore` (`@/store`); UI state lives in `useSecurityUiStore`.
 */
export { SecurityBanner } from './components/SecurityBanner.tsx';
export { SecurityDialogs } from './components/SecurityDialogs.tsx';
export {
  openSecurityDialog,
  useSecurityUiStore,
  bannerNeed,
  formatRecoveryKey,
  type SecurityDialogKind,
  type BannerNeed,
} from './state.ts';
