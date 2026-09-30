import { expect, test } from '@playwright/test';
import { loginAs } from '../fixtures/auth.ts';
import { messageList } from '../fixtures/ui.ts';

test('diagnose row height collapse in the message list', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'alice');
  await expect(messageList(page)).toBeVisible();

  const report = await messageList(page).evaluate((list) => {
    const listCs = getComputedStyle(list);
    const rows = [...list.querySelectorAll('[data-testid^="message-$"]')] as HTMLElement[];
    const sample = rows.slice(-8).map((r) => {
      const cs = getComputedStyle(r);
      const content = r.lastElementChild as HTMLElement | null;
      const kids = [...r.children] as HTMLElement[];
      const contentHeight = kids.reduce((max, k) => Math.max(max, k.getBoundingClientRect().height), 0);
      return {
        id: (r.dataset.eventId ?? '').slice(0, 10),
        rowH: Math.round(r.getBoundingClientRect().height),
        tallestChildH: Math.round(contentHeight),
        flexShrink: cs.flexShrink,
        minHeight: cs.minHeight,
        overflows: Math.round(contentHeight) > Math.round(r.getBoundingClientRect().height),
        contentCls: content?.className?.toString().slice(0, 30),
      };
    });
    return {
      list: {
        display: listCs.display,
        flexDirection: listCs.flexDirection,
        clientH: list.clientHeight,
        scrollH: list.scrollHeight,
      },
      rowCount: rows.length,
      sample,
    };
  });
  console.log(JSON.stringify(report, null, 2));
});
