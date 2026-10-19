/**
 * Off-canvas drawer container (phone shell, PRIN-3). Purely presentational: the Shell decides what goes
 * inside and when it is open (`useLayoutStore`). Closed drawers are `visibility: hidden` (not in the
 * accessibility tree, not tabbable, `toBeVisible()` false) and slide in over 250 ms when opened.
 *
 * Props: `side` left|right, `open`, `label` (aria), `testId` (`nav-drawer` / `member-drawer`),
 * `data-open="true|false"` is stamped for tests (docs/archive/PHASE2_ACCEPTANCE.md).
 */
import type { ReactNode } from 'react';
import styles from './Drawer.module.css';

export interface DrawerProps {
  side: 'left' | 'right';
  open: boolean;
  label: string;
  testId: string;
  children: ReactNode;
}

export function Drawer({ side, open, label, testId, children }: DrawerProps) {
  return (
    <div
      className={`${styles.drawer} ${side === 'left' ? styles.left : styles.right} ${open ? styles.open : ''}`}
      data-testid={testId}
      data-open={open ? 'true' : 'false'}
      data-side={side}
      role="dialog"
      aria-modal={open}
      aria-label={label}
      aria-hidden={!open}
    >
      {children}
    </div>
  );
}
