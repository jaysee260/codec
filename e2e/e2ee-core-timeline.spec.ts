/**
 * Phase 5 QA-25: crypto boot, persistence, wipe (AC-E1), decrypting the timeline (AC-E2), encrypted by default
 * (AC-E6), key import (AC-E7-3). Desktop, serial, at most two contexts (alice in `page`, bob in a second context).
 *
 * Which criteria need what:
 *  - **sample script + key import** (`scripts/send-encrypted-sample.mjs`, `seed/e2ee-keys.json`): AC-E2-2, AC-E2-4,
 *    AC-E7-3. The script's device sends *before* alice's device exists, so alice gets a genuine historical UTD.
 *  - **live second context** (bob-B): AC-E2-1, AC-E2-5, AC-E2-7 (bob closes before alice logs in).
 *  - **API only**: AC-E1-4 (`DELETE /devices`), AC-E6-6 (bob turns a room encrypted).
 * Every criterion asserts the core half through the dev hook and the wire through the API; the UI halves owned by
 * Dev A / Dev B are `uiHalf` / `requireUi` and say "waiting on Dev A/B" until their testids are in `src/`.
 * alice's account cross-signing state is NOT touched here (that is e2ee-security.spec.ts, on throwaway users).
 *
 * Part timeline (AC-E2, AC-E7-3) of the former `e2ee-core.spec.ts`, split (issue #2, docs/PERF_PLAN.md) so the two
 * halves can run on different Playwright workers; tests moved verbatim. Other half: `e2ee-core-boot.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { asUser, type ApiUser, type MatrixEventJson } from './fixtures/matrix-api.ts';
import { resolveRoom, userId } from './fixtures/seed.ts';
import { composer, openChannel, openSpace, row, rowByText, settledEventId, typeAndSend, hoverActions, channelItem } from './fixtures/ui.ts';
import { openThreadFromMessage, openThreadFromSummary, replyInThreadAndSettle, threadPanel, threadSummary } from './fixtures/threads.ts';
import {
  expectEncryptedOnWire,
  keyBackup,
  rawEvent,
  redact,
} from './fixtures/e2ee-api.ts';
import {
  e2eeAfterEach,
  expectDecryptedRow,
  expectUtd,
  importSampleKeys,
  loginWith,
  logoutQuietly,
  runSample,
  secondContext,
  uiHalf,
  waitForEventState,
  waitForStatus,
} from './fixtures/e2ee.ts';
import { annotate } from './fixtures/state.ts';

// Sequential (workers: 1) but not `serial`: one red criterion must not hide the rest.
test.describe.configure({ timeout: 150_000 });

const R = { vault: '', general: '', acme: '', gaming: '' };
let alice: ApiUser;
let bob: ApiUser;
const created: { roomId: string; parent?: string }[] = [];

test.beforeAll(async () => {
  R.vault = await resolveRoom('vault');
  R.general = await resolveRoom('general');
  R.acme = await resolveRoom('acme-hq');
  R.gaming = await resolveRoom('gaming');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
});

test.afterAll(async () => {
  for (const { roomId, parent } of created) {
    try {
      if (!parent) {
        // A space made in the UI comes with its own #general: leave it too, or alice keeps an
        // orphan encrypted "general" in Other Rooms after every run.
        const kids = await alice.hierarchy(roomId).catch(() => ({ rooms: [] as { room_id: string }[] }));
        for (const kid of kids.rooms) {
          if (kid.room_id === roomId) continue;
          await alice.leaveRoom(kid.room_id).catch(() => undefined);
          await alice.forgetRoom(kid.room_id).catch(() => undefined);
        }
      }
      if (parent) await alice.sendStateEvent(parent, 'm.space.child', roomId, {});
      await alice.leaveRoom(roomId);
      await alice.forgetRoom(roomId);
    } catch {
      /* best effort */
    }
  }
});

async function openVault(page: Page): Promise<void> {
  // A fresh login can land on Home (DMs): pick Acme HQ first.
  if (!(await channelItem(page, R.vault).isVisible().catch(() => false))) await openSpace(page, R.acme);
  await openChannel(page, R.vault);
}

const uniq = (label: string): string => `[qa] ${label} ${Date.now().toString(36)}`;

/** The data-reason AC-E2-2 expects for a historical UTD given the account's backup state. */
async function historicalReason(): Promise<{ reason: string; code: string }> {
  return (await keyBackup(alice.token))
    ? { reason: 'locked-backup', code: 'HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED' }
    : { reason: 'no-backup', code: 'HISTORICAL_MESSAGE_NO_KEY_BACKUP' };
}

const REASON_COPY: Record<string, string> = {
  'locked-backup': 'Unlock with your recovery key to read older messages',
  'no-backup': "This session can't read older messages (no key backup)",
  restoring: 'Restoring from backup...',
  unverified: "The sender's device withheld the key. Verify this session.",
  'not-joined': 'Sent before you joined',
  unknown: 'Unable to decrypt',
};

/* ================================================================== AC-E2 timeline */

test.describe('AC-E2 decrypting the timeline', () => {
  test('AC-E2-1 bob-B sends in #vault: encrypted on the wire, alice-A reads it within 5 s', async ({ page, browser }) => {
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const b = await secondContext(browser, 'bob');
    {
      await waitForStatus(b.page);
      await openVault(b.page);
      const text = uniq('hi alice');
      await typeAndSend(b.page, text);
      const id = await settledEventId(rowByText(b.page, text), 20_000);

      expectEncryptedOnWire(await rawEvent(alice.token, R.vault, id));
      const r = await expectDecryptedRow(page, text, 5_000);
      await expect(r).toHaveAttribute('data-sender', userId('bob'));
      const info = await page.evaluate(
        async ([roomId, eventId]) => {
          const w = (window as any).__matrixPoc;
          const ev = w.getClient().getRoom(roomId).findEventById(eventId);
          const i = await w.security.getEventEncryptionInfo(ev);
          return i ? { ok: true } : null;
        },
        [R.vault, id] as const,
      );
      expect(info, 'getEventEncryptionInfo non-null').not.toBeNull();
    }
    await b.close();
  });

  test('AC-E2-2 + AC-E2-3 + AC-E7-3 history sent before this device: UTD placeholder, then the key import decrypts it', async ({ page }) => {
    const sample = runSample({ count: 2 });
    const { reason, code } = await historicalReason();
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);

    for (const id of sample.eventIds) {
      const st = await waitForEventState(page, R.vault, id, (s) => s.found && s.decryption?.status === 'failed', `${id} fails to decrypt`, 20_000);
      expect(st.decryption!.code, 'historical failure code').toBe(code);
      expect(st.decryption!.historical).toBe(true);
      expect(st.preview, 'previewText of a UTD').toBe('Unable to decrypt');
    }

    await uiHalf('Dev B', ['message-undecryptable'], async () => {
      for (const id of sample.eventIds) {
        const ph = await expectUtd(page, id, reason);
        await expect(row(page, id)).toHaveAttribute('data-sender', userId('bob'));
        expect.soft(await ph.innerText(), `AC-E2-3 copy for ${reason}`).toContain(REASON_COPY[reason]);
        const action = row(page, id).getByTestId('message-undecryptable-action');
        if (reason === 'locked-backup') await expect(action).toHaveText(/Unlock/);
        else await expect(action).toHaveCount(0);
      }
    });

    // AC-E7-3: the keys file decrypts the same rows within 10 s, no reload.
    await importSampleKeys(page);
    for (const [i, id] of sample.eventIds.entries()) {
      const st = await waitForEventState(page, R.vault, id, (s) => s.decryption?.status === 'decrypted' || (s.decryption?.status === 'none' && s.text !== undefined), `${id} decrypts after import`, 10_000);
      expect(st.text).toBe(`vault sample ${i + 1}`);
    }
    await expect(row(page, sample.eventIds[1]).getByTestId('message-body')).toHaveText('vault sample 2', { timeout: 10_000 });
    await expect(row(page, sample.eventIds[1]).getByTestId('message-undecryptable')).toHaveCount(0);
  });

  test('AC-E2-4 a redacted encrypted event shows message-redacted, decryptable or not', async ({ page }) => {
    const utd = runSample({ count: 1 }).eventIds[0];
    await redact(bob.token, R.vault, utd);
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    await expect(row(page, utd).getByTestId('message-redacted')).toBeVisible({ timeout: 15_000 });
    await expect(row(page, utd).getByTestId('message-undecryptable')).toHaveCount(0);

    // Live: this device gets the key, decrypts, then the event is deleted.
    const live = runSample({ count: 1 }).eventIds[0];
    await waitForEventState(page, R.vault, live, (s) => s.text === 'vault sample 1', 'live sample decrypts', 15_000);
    await redact(bob.token, R.vault, live);
    await expect(row(page, live).getByTestId('message-redacted')).toBeVisible({ timeout: 15_000 });
    await expect(row(page, live).getByTestId('message-undecryptable')).toHaveCount(0);
  });

  test('AC-E2-5 (edit, reply, reaction, delete) from bob-B decrypt on alice-A', async ({ page, browser }) => {
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const b = await secondContext(browser, 'bob');
    {
      const bp = b.page;
      await waitForStatus(bp);
      await openVault(bp);
      const base = uniq('e2ee root');
      await typeAndSend(bp, base);
      const root = await settledEventId(rowByText(bp, base), 20_000);
      await expectDecryptedRow(page, base);

      // edit
      await (await hoverActions(bp, root)).getByTestId('message-action-edit').click();
      await composer(bp).fill(`${base} edited`);
      await composer(bp).press('Enter');
      await expect(row(bp, root).getByTestId('message-edited')).toBeVisible({ timeout: 15_000 });
      // reply
      await (await hoverActions(bp, root)).getByTestId('message-action-reply').click();
      const replyText = uniq('e2ee reply');
      await composer(bp).fill(replyText);
      await composer(bp).press('Enter');
      const reply = await settledEventId(rowByText(bp, replyText), 20_000);
      // reaction
      await (await hoverActions(bp, root)).getByTestId('message-action-react').click();
      await bp.getByTestId('reaction-picker').getByTestId('reaction-picker-👍').click();
      await expect(row(bp, root).getByTestId('reaction-👍')).toBeVisible({ timeout: 15_000 });
      // delete
      const doomedText = uniq('e2ee doomed');
      await typeAndSend(bp, doomedText);
      const doomed = await settledEventId(rowByText(bp, doomedText), 20_000);
      await (await hoverActions(bp, doomed)).getByTestId('message-action-delete').click();
      await bp.getByTestId('delete-confirm').click();

      // alice-A
      await expect(row(page, root).getByTestId('message-body')).toContainText(`${base} edited`, { timeout: 15_000 });
      await expect(row(page, root).getByTestId('message-edited')).toBeVisible();
      await expect(row(page, reply).getByTestId('message-reply-quote')).toContainText(base, { timeout: 15_000 });
      await expect(row(page, root).getByTestId('reaction-👍')).toHaveAttribute('data-count', '1', { timeout: 15_000 });
      await expect(row(page, doomed).getByTestId('message-redacted')).toBeVisible({ timeout: 15_000 });

      // wire: relations in cleartext, edits and reactions encrypted
      const recent = await bob.messages(R.vault, 40);
      const relOf = (e: MatrixEventJson) => e.content?.['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined;
      const edit = recent.find((e) => relOf(e)?.rel_type === 'm.replace' && relOf(e)?.event_id === root);
      const reaction = recent.find((e) => relOf(e)?.rel_type === 'm.annotation' && relOf(e)?.event_id === root);
      expect(edit, 'the edit').toBeTruthy();
      expect(reaction, 'the reaction').toBeTruthy();
      expectEncryptedOnWire(edit as never, { relation: 'm.replace', label: 'edit' });
      // matrix-js-sdk never encrypts m.reaction (Element parity); the PM is rewording AC-E2-5 (coordinator 2026-10-18).
      expect((reaction as MatrixEventJson).content['m.relates_to'], 'reaction relation in cleartext').toMatchObject({ rel_type: 'm.annotation', event_id: root });
      const replyWire = await rawEvent(alice.token, R.vault, reply);
      expectEncryptedOnWire(replyWire, { label: 'reply' });
      expect((replyWire.content['m.relates_to'] as any)?.['m.in_reply_to']?.event_id, 'reply relation in cleartext').toBe(root);
    }
    await b.close();
  });

  test('AC-E2-5 (thread reply) from bob-B decrypts in alice-A\'s summary and panel', async ({ page, browser }) => {
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const b = await secondContext(browser, 'bob');
    {
      const bp = b.page;
      await waitForStatus(bp);
      await openVault(bp);
      const base = uniq('e2ee thread root');
      await typeAndSend(bp, base);
      const root = await settledEventId(rowByText(bp, base), 20_000);
      await openThreadFromMessage(bp, root);
      const threadText = uniq('e2ee thread');
      const threadReply = await replyInThreadAndSettle(bp, threadText);

      await expect(threadSummary(page, root)).toBeVisible({ timeout: 15_000 });
      await expect(threadSummary(page, root)).toContainText('1 reply');
      await openThreadFromSummary(page, root);
      await expect(threadPanel(page).getByTestId(`message-${threadReply}`).getByTestId('message-body')).toHaveText(threadText, { timeout: 15_000 });
      const threadWire = await rawEvent(alice.token, R.vault, threadReply);
      expectEncryptedOnWire(threadWire, { relation: 'm.thread', label: 'thread reply' });
      expect((threadWire.content['m.relates_to'] as any).event_id).toBe(root);
    }
    await b.close();
  });

  test('AC-E2-7 a thread whose root is undecryptable still shows its count and opens', async ({ page, browser }) => {
    const b = await secondContext(browser, 'bob');
    let root = '';
    {
      await waitForStatus(b.page);
      await openVault(b.page);
      const text = uniq('e2ee utd root');
      await typeAndSend(b.page, text);
      root = await settledEventId(rowByText(b.page, text), 20_000);
      // The criterion is alice's view; bob's reply goes through the app's own action (not the panel).
      await b.page.evaluate(([r, id, t]) => (window as any).__matrixPoc.actions.sendText(r, t, { threadRoot: id }), [R.vault, root, uniq('e2ee utd reply')] as const);
    }
    await b.close(); // closed before alice's device exists: alice never gets this session
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    await waitForEventState(page, R.vault, root, (s) => s.decryption?.status === 'failed', 'root is a UTD', 20_000);
    await expect(threadSummary(page, root)).toBeVisible({ timeout: 15_000 });
    await expect(threadSummary(page, root)).toContainText('1 reply');
    await openThreadFromSummary(page, root);
    await uiHalf('Dev B', ['message-undecryptable'], async () => {
      await expect(page.getByTestId('thread-root').getByTestId('message-undecryptable')).toBeVisible({ timeout: 15_000 });
    });
  });

  test('regression (Dev B): a redacted encrypted edit never becomes a row, live or from history', async ({ page, browser }) => {
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const b = await secondContext(browser, 'bob');
    let root = '';
    let editId = '';
    {
      await waitForStatus(b.page);
      await openVault(b.page);
      const base = uniq('e2ee redacted edit');
      await typeAndSend(b.page, base);
      root = await settledEventId(rowByText(b.page, base), 20_000);
      editId = await b.page.evaluate(([r, id, t]) => (window as any).__matrixPoc.actions.editText(r, id, t), [R.vault, root, `${base} v2`] as const);
      expectEncryptedOnWire(await rawEvent(alice.token, R.vault, editId), { relation: 'm.replace', label: 'edit' });
      await expect(row(page, root).getByTestId('message-edited')).toBeVisible({ timeout: 15_000 });
      await redact(bob.token, R.vault, editId);
    }
    await b.close();
    // live: the redaction strips the (encrypted) relation; the edit must not surface as "Message deleted"
    await page.waitForTimeout(2_000);
    await expect(row(page, editId)).toHaveCount(0);
    await expect(row(page, root)).toBeVisible();
    // history: a fresh device paginates the redacted edit in from the server
    await logoutQuietly(page);
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    await expect(row(page, root)).toBeVisible({ timeout: 15_000 });
    // Room v11 redaction empties the whole m.room.encrypted content (no m.relates_to survives; MSC3389 is not in
    // v11), so a device that never saw the edit cannot know it was one. Element shows it as a deleted message too.
    // The floor: it is never an undecryptable placeholder.
    if (await row(page, editId).count()) {
      annotate('known-limit', 'redacted encrypted edit from history renders as a deleted row (relation stripped by the server)');
      await expect(row(page, editId).getByTestId('message-redacted')).toBeVisible();
      await expect(row(page, editId).getByTestId('message-undecryptable')).toHaveCount(0);
    }
  });

  test('regression (Dev B): a reply quote to a late-decrypted target updates (never stuck on "Decrypting...")', async ({ page, browser }) => {
    const target = runSample({ count: 1 }).eventIds[0]; // before alice's device exists: a UTD for her
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const b = await secondContext(browser, 'bob');
    let reply = '';
    const replyText = uniq('e2ee reply to utd');
    {
      await waitForStatus(b.page);
      await openVault(b.page);
      reply = await b.page.evaluate(([r, t, id]) => (window as any).__matrixPoc.actions.sendText(r, t, { replyTo: id }), [R.vault, replyText, target] as const);
    }
    await b.close();
    const quote = row(page, reply).getByTestId('message-reply-quote');
    await expect(row(page, reply).getByTestId('message-body')).toContainText(replyText, { timeout: 15_000 });
    await expect(quote).toBeVisible();
    await expect(quote).toContainText('Unable to decrypt', { timeout: 10_000 });
    await expect(quote).not.toContainText('Decrypting');
    await importSampleKeys(page);
    await expect(quote).toContainText('vault sample 1', { timeout: 10_000 });
    // after a reload the target decrypts from the store; the quote must follow
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await openVault(page);
    await expect(row(page, reply).getByTestId('message-reply-quote')).toContainText('vault sample 1', { timeout: 15_000 });
  });

  test('regression (21179cb b): an edit and a reaction from bob-B, and redacting the reaction, add no rows on alice-A', async ({ page, browser }) => {
    await loginWith(page, 'alice');
    await waitForStatus(page);
    await openVault(page);
    const b = await secondContext(browser, 'bob');
    await waitForStatus(b.page);
    await openVault(b.page);
    const base = uniq('e2ee no extra rows');
    await typeAndSend(b.page, base);
    const root = await settledEventId(rowByText(b.page, base), 20_000);
    await expectDecryptedRow(page, base);
    const rowIds = () => page.getByTestId('message-list').evaluate((list) => [...list.querySelectorAll('[data-testid^="message-$"],[data-testid^="message-~"]')].map((e) => e.getAttribute('data-testid')!));
    const before = await rowIds();

    const editId = await b.page.evaluate(([r, id, t]) => (window as any).__matrixPoc.actions.editText(r, id, t), [R.vault, root, `${base} v2`] as const);
    await (await hoverActions(b.page, root)).getByTestId('message-action-react').click();
    await b.page.getByTestId('reaction-picker').getByTestId('reaction-picker-👍').click();
    await expect(row(page, root).getByTestId('message-body')).toContainText(`${base} v2`, { timeout: 15_000 });
    await expect(row(page, root).getByTestId('reaction-👍')).toBeVisible({ timeout: 15_000 });
    const reaction = (await bob.messages(R.vault, 30)).find((e) => (e.content?.['m.relates_to'] as any)?.rel_type === 'm.annotation' && (e.content?.['m.relates_to'] as any)?.event_id === root);
    expect(reaction).toBeTruthy();
    expect(await row(page, editId).count()).toBe(0);
    expect(await row(page, reaction!.event_id).count()).toBe(0);
    expect((await rowIds()).filter((id) => !before.includes(id)), 'no new rows for the edit / reaction').toEqual([]);

    await redact(bob.token, R.vault, reaction!.event_id);
    await expect(row(page, root).getByTestId('reaction-👍')).toHaveCount(0, { timeout: 15_000 });
    await page.waitForTimeout(1_000);
    expect((await rowIds()).filter((id) => !before.includes(id)), 'redacting the reaction adds no row').toEqual([]);
    await b.close();
  });

  test.fixme('AC-E2-8 message-decrypting then settle without a layout jump (P1)', async () => {
    // `isBeingDecrypted()` lasts milliseconds locally; there is no deterministic way to hold an event in that state
    // from outside the app. Judged by eye in the demo; revisit if the Principal adds a dev hook to delay decryption.
  });
});
