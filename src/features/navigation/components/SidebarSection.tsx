/**
 * Discord's uppercase 12 px sidebar section header: chevron that collapses the section, the label,
 * and an optional "+" action on the right. Used by the channel list and the DM list (DEV-A-10).
 */
import type { ReactNode } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { useNavUiStore } from '../state.ts';
import styles from './SidebarSection.module.css';

export function SidebarSection({
  id,
  label,
  addTestId,
  addTitle,
  onAdd,
  children,
}: {
  /** Stable key for the collapsed flag. */
  id: string;
  label: string;
  addTestId?: string;
  addTitle?: string;
  onAdd?(): void;
  children: ReactNode;
}) {
  const collapsed = useNavUiStore((s) => !!s.collapsed[id]);
  const toggleSection = useNavUiStore((s) => s.toggleSection);

  return (
    <section className={styles.section}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.headButton}
          aria-expanded={!collapsed}
          title={collapsed ? `Show ${label}` : `Hide ${label}`}
          onClick={() => toggleSection(id)}
        >
          <ChevronDown size={12} className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ''}`} />
          <span className={styles.label}>{label}</span>
        </button>
        {onAdd && (
          <button type="button" className={styles.add} data-testid={addTestId} title={addTitle} onClick={onAdd}>
            <Plus size={18} />
          </button>
        )}
      </div>
      {!collapsed && <div className={styles.items}>{children}</div>}
    </section>
  );
}
