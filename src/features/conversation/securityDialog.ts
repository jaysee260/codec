/**
 * `openSecurityDialog` from Dev A's `@/features/security`, resolved through a glob like the Shell does, so the
 * conversation feature builds (and its placeholder rows render) whether or not that module exists yet. The
 * module is loaded on the first click only.
 */
import { showToast } from '@/store/toast.ts';

export type SecurityDialogKind = 'setup' | 'verify' | 'unlock';

type SecurityModule = { openSecurityDialog?: (kind: SecurityDialogKind) => void };

const modules = import.meta.glob<SecurityModule>('../security/index.ts');
const load = Object.values(modules)[0];

export function openSecurityDialog(kind: SecurityDialogKind): void {
  if (!load) {
    showToast('Encryption settings are not available in this build', 'error');
    return;
  }
  void load().then(
    (mod) => {
      if (mod.openSecurityDialog) mod.openSecurityDialog(kind);
      else showToast('Encryption settings are not available in this build', 'error');
    },
    (e: unknown) => {
      console.warn('[conversation] could not load the security UI', e);
      showToast('Could not open the encryption settings', 'error');
    },
  );
}
