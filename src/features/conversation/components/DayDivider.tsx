/** Date separator between days in the timeline (DEV-B-1). */
import { formatDayDivider } from '@/lib/format.ts';
import styles from './DayDivider.module.css';

export function DayDivider({ ts }: { ts: number }) {
  return (
    <div className={styles.divider} data-testid="day-divider" role="separator">
      <span className={styles.label}>{formatDayDivider(ts)}</span>
    </div>
  );
}
