/**
 * Mac app (desktop/): the web side of the bridge. The Electron shell injects `window.codecDesktop`; here a stand-in
 * does, so the plain desktop project can check what Codec sends it: the Dock badge follows the unread total, a new
 * DM pops a notification whose click opens that DM, and the device is named "Codec (Mac)". The shell itself
 * (navigation, SSO, close-to-hide) is covered by desktop/test/launch.test.mjs.
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { asUser } from './fixtures/matrix-api.ts';
import { DISPLAY_NAMES, resolveRoom, uniqueName } from './fixtures/seed.ts';

type Spy = { badges: number[]; notes: { title: string; body: string }[]; focus: number };

async function installBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy: Spy = { badges: [], notes: [], focus: 0 };
    const w = window as unknown as { __desktopSpy: Spy; codecDesktop: unknown; Notification: unknown };
    w.__desktopSpy = spy;
    w.codecDesktop = {
      platform: 'darwin',
      setBadge: (n: number) => spy.badges.push(n),
      focus: () => void spy.focus++,
      attention: () => undefined,
    };
    const notes: { onclick: (() => void) | null }[] = [];
    w.Notification = class {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body: string }) {
        spy.notes.push({ title, body: opts.body });
        notes.push(this);
      }
    };
    (window as unknown as { __desktopNotes: typeof notes }).__desktopNotes = notes;
  });
}

const spy = (page: Page): Promise<Spy> => page.evaluate(() => (window as unknown as { __desktopSpy: Spy }).__desktopSpy);

/** The unread total the badge should show, from the room store (dev hook). */
const expectedBadge = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const s = (window as unknown as { __matrixPoc: { rooms: { getState(): { roomsById: Record<string, { isSpace: boolean; unread: number }>; invites: unknown[] } } } }).__matrixPoc.rooms.getState();
    return Object.values(s.roomsById).reduce((n, r) => n + (r.isSpace ? 0 : Math.max(0, r.unread)), 0) + s.invites.length;
  });

test.describe('Mac app bridge', () => {
  test('Dock badge tracks unread, a new DM notifies and its click opens the DM', async ({ page }) => {
    await installBridge(page);
    await loginAs(page, 'alice');
    await expect.poll(async () => (await spy(page)).badges.at(-1)).toBe(await expectedBadge(page));
    const deviceName = await page.evaluate(async () => {
      const client = (window as unknown as { __matrixPoc: { getClient(): { getDeviceId(): string; getDevice(id: string): Promise<{ display_name?: string }> } } }).__matrixPoc.getClient();
      return (await client.getDevice(client.getDeviceId())).display_name;
    });
    expect(deviceName).toBe('Codec (Mac)');

    const before = (await spy(page)).badges.at(-1) ?? 0;
    const dm = await resolveRoom('dm-alice-bob');
    const body = uniqueName('mac notification');
    const bob = await asUser('bob');
    await bob.send(dm, body);

    await expect.poll(async () => (await spy(page)).notes.find((n) => n.body === body)).toEqual({ title: DISPLAY_NAMES.bob, body });
    await expect.poll(async () => (await spy(page)).badges.at(-1)).toBeGreaterThan(before);

    await page.evaluate(() => (window as unknown as { __desktopNotes: { onclick: (() => void) | null }[] }).__desktopNotes.at(-1)?.onclick?.());
    await expect.poll(async () => (await spy(page)).focus).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __matrixPoc: { rooms: { getState(): { selectedRoomId: string | null } } } }).__matrixPoc.rooms.getState().selectedRoomId)).toBe(dm);
  });

  test('my own messages never notify', async ({ page }) => {
    await installBridge(page);
    await loginAs(page, 'alice');
    const alice = await asUser('alice');
    const body = uniqueName('own message');
    await alice.send(await resolveRoom('dm-alice-bob'), body);
    // Sentinel: bob's message after mine arrives and notifies, so mine had its chance to.
    const sentinel = uniqueName('sentinel');
    await (await asUser('bob')).send(await resolveRoom('dm-alice-bob'), sentinel);
    await expect.poll(async () => (await spy(page)).notes.some((n) => n.body === sentinel)).toBe(true);
    expect((await spy(page)).notes.some((n) => n.body === body)).toBe(false);
  });
});
