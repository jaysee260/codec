/**
 * QA-4 — navigation suite, AC-A1-1 .. AC-A9-1 (docs/ACCEPTANCE.md).
 *
 * Every test logs in fresh (its own browser context, so localStorage starts empty and the app
 * lands on the store's default selection). Shared state comes only from the seed fixtures.
 *
 * Two deliberate deviations from the literal wording of the criteria, both forced by running
 * against a homeserver the devs are using live and that must not be reset during this phase:
 *
 *  - Lists that the criteria describe by their seeded contents ("channel-list contains only
 *    `lobby`", "dm-list shows Bob Ruiz and Carol Nguyen") are asserted against *server truth*
 *    (the space hierarchy / `m.direct`), and `noteSeedDrift` records an annotation when that no
 *    longer matches the number in the doc. Otherwise the first `create channel` run would break
 *    AC-A1-3 forever.
 *  - Rooms this suite creates are cleaned up afterwards (child link removed, room left and
 *    forgotten) so repeat runs do not pile up channels in Gaming.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { requireFreshSeed } from './fixtures/fresh.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import {
  BODIES,
  DISPLAY_NAMES,
  NAMES,
  TOPICS,
  resolveRoom,
  uniqueName,
  userId,
} from './fixtures/seed.ts';
import { annotate, childRoomIds, ensureUnread, noteSeedDrift, revokePendingInvite } from './fixtures/state.ts';
import {
  badgeCount,
  byName,
  channelItem,
  dmItem,
  itemNames,
  messageList,
  openChannel,
  openHome,
  openSpace,
  railOrder,
  spaceItem,
} from './fixtures/ui.ts';

const ALICE = userId('alice');
const BOB = userId('bob');
const CAROL = userId('carol');
const DAVE = userId('dave');

let admin: ApiUser;
let bob: ApiUser;

const R = { acme: '', gaming: '', general: '', random: '', dev: '', lobby: '', dmBob: '', dmCarol: '' };

/** Rooms created by this suite, torn down in afterAll. */
const created: { roomId: string; parentSpaceId?: string }[] = [];

test.beforeAll(async () => {
  R.acme = await resolveRoom('acme-hq');
  R.gaming = await resolveRoom('gaming');
  R.general = await resolveRoom('general');
  R.random = await resolveRoom('random');
  R.dev = await resolveRoom('dev');
  R.lobby = await resolveRoom('lobby');
  R.dmBob = await resolveRoom('dm-alice-bob');
  R.dmCarol = await resolveRoom('dm-alice-carol');
  admin = await asUser('alice');
  bob = await asUser('bob');
});

test.afterAll(async () => {
  for (const { roomId, parentSpaceId } of created) {
    try {
      if (parentSpaceId) {
        // Drop the m.space.child link so the channel stops showing in the sidebar.
        await admin.sendStateEvent(parentSpaceId, 'm.space.child', roomId, {});
      }
      await admin.leaveRoom(roomId);
      await admin.forgetRoom(roomId);
    } catch {
      // Cleanup is best effort: a leftover room is noise, not a failing criterion.
    }
  }
});

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'alice');
});

/** The channel names the server says alice has joined in a space, in `m.space.child` order. */
async function expectedChannelNames(spaceId: string): Promise<string[]> {
  const { rooms } = await admin.hierarchy(spaceId);
  const space = rooms.find((r) => r.room_id === spaceId);
  const order = new Map<string, string>();
  for (const child of space?.children_state ?? []) {
    order.set(child.state_key, child.content?.order ?? '');
  }
  return rooms
    .filter((r) => r.room_id !== spaceId && order.has(r.room_id))
    .sort((a, b) => {
      const byOrder = (order.get(a.room_id) ?? '').localeCompare(order.get(b.room_id) ?? '');
      return byOrder !== 0 ? byOrder : (a.name ?? '').localeCompare(b.name ?? '');
    })
    .map((r) => r.name ?? r.room_id);
}

/**
 * Waits for a newly created channel to show up in the sidebar, and on failure records what the
 * sidebar actually held. Without this the report only says "element(s) not found", which does not
 * distinguish "the room never arrived" from "the room arrived without its name yet" (BUG-3).
 */
async function expectChannelListed(page: Page, item: Locator, name: string): Promise<void> {
  try {
    await expect(item).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    const shown = await page
      .getByTestId('channel-list')
      .locator('[data-testid^="channel-item-"]')
      .evaluateAll((els) =>
        els.map((el) => ({ testid: el.getAttribute('data-testid'), name: (el as HTMLElement).dataset.name })),
      );
    annotate(
      'diagnostic',
      `channel "${name}" never appeared. channel-list held ${shown.length} item(s): ${JSON.stringify(shown)}`,
    );
    throw error;
  }
}

test.describe('DEV-A-1 space rail', () => {
  test('AC-A1-1 rail shows Home, then Acme HQ and Gaming in that order', async ({ page }) => {
    const rail = page.getByTestId('space-rail');
    await expect(page.getByTestId('space-item-home')).toBeVisible();
    await expect(byName(rail, NAMES.acme)).toBeVisible();
    await expect(byName(rail, NAMES.gaming)).toBeVisible();
    expect(await railOrder(page)).toEqual([
      'space-item-home',
      `space-item-${R.acme}`,
      `space-item-${R.gaming}`,
    ]);
  });

  test('AC-A1-2 Acme HQ is selected on first load and its channels are listed', async ({ page }) => {
    await expect(spaceItem(page, R.acme)).toHaveAttribute('data-selected', 'true');
    await expect(channelItem(page, R.general)).toBeVisible();
    await expect(channelItem(page, R.random)).toBeVisible();
    await expect(channelItem(page, R.dev)).toBeVisible();
  });

  test('AC-A1-3 clicking Gaming selects it and lists only its channels', async ({ page }) => {
    await openSpace(page, R.gaming);
    await expect(page.getByTestId('space-header-name')).toHaveText(NAMES.gaming);

    const expected = await expectedChannelNames(R.gaming);
    noteSeedDrift('AC-A1-3 (Gaming channel count)', 1, expected.length);
    expect(await itemNames(page.getByTestId('channel-list'), 'channel-item-')).toEqual(expected);
    await expect(channelItem(page, R.lobby)).toBeVisible();
    // No channel from another space leaks in.
    await expect(channelItem(page, R.general)).toHaveCount(0);
  });

  test('AC-A1-4 clicking Home shows the DM list and hides the channel list', async ({ page }) => {
    await openHome(page);
    await expect(page.getByTestId('dm-list')).toBeVisible();
    await expect(page.getByTestId('channel-list')).toHaveCount(0);
  });

  test('AC-A1-5 each space item carries a title tooltip equal to its name', async ({ page }) => {
    await expect(spaceItem(page, R.acme)).toHaveAttribute('title', NAMES.acme);
    await expect(spaceItem(page, R.gaming)).toHaveAttribute('title', NAMES.gaming);
  });
});

test.describe('DEV-A-2 channel list and header', () => {
  test('AC-A2-1 Acme channels are general, random, dev in m.space.child order, each prefixed with #', async ({
    page,
  }) => {
    expect(await itemNames(page.getByTestId('channel-list'), 'channel-item-')).toEqual([
      NAMES.general,
      NAMES.random,
      NAMES.dev,
    ]);
    for (const [roomId, name] of [
      [R.general, NAMES.general],
      [R.random, NAMES.random],
      [R.dev, NAMES.dev],
    ] as const) {
      const text = (await channelItem(page, roomId).innerText()).trim();
      expect(text, `channel item for ${name} must be prefixed with #`).toMatch(new RegExp(`^#\\s*${name}\\b`));
    }
  });

  test('AC-A2-2 general is selected on load with its name and topic in the header', async ({ page }) => {
    await expect(channelItem(page, R.general)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);
    await expect(page.getByTestId('channel-header-topic')).toContainText(TOPICS.general);
  });

  test('AC-A2-3 clicking random selects it and shows its first message', async ({ page }) => {
    // The criterion names #random's *first* seeded message, which is only on screen while the
    // initial ~30-event window still reaches back to it; paging back would contradict its "within
    // 1 s". So it needs a pristine seed (this one started failing once #random grew past 30 events).
    await requireFreshSeed(test);
    await openChannel(page, R.random);
    await expect(channelItem(page, R.random)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.random);
    await expect(messageList(page).getByText(BODIES.random1)).toBeVisible({ timeout: 5_000 });
  });

  test('AC-A2-4 switching space and back restores that space last channel', async ({ page }) => {
    await openChannel(page, R.dev);
    await openSpace(page, R.gaming);
    await expect(channelItem(page, R.lobby)).toHaveAttribute('data-selected', 'true');
    await openSpace(page, R.acme);
    await expect(channelItem(page, R.dev)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.dev);
  });

  test('AC-A2-5 the selected space and channel survive a reload', async ({ page }) => {
    await openChannel(page, R.random);
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
    await expect(spaceItem(page, R.acme)).toHaveAttribute('data-selected', 'true');
    await expect(channelItem(page, R.random)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.random);
  });
});

test.describe('DEV-A-3 DM list', () => {
  test('AC-A3-1 the DM list is built from m.direct and shows display names with avatars', async ({ page }) => {
    await openHome(page);
    const direct = await admin.directMap();
    const expectedRoomIds = new Set(Object.values(direct).flat());
    noteSeedDrift('AC-A3-1 (DM count)', 2, expectedRoomIds.size);

    await expect(byName(page.getByTestId('dm-list'), DISPLAY_NAMES.bob)).toBeVisible();
    await expect(byName(page.getByTestId('dm-list'), DISPLAY_NAMES.carol)).toBeVisible();

    const shown = await page
      .getByTestId('dm-list')
      .locator('[data-testid^="dm-item-"]')
      .evaluateAll((els) => els.map((el) => (el.getAttribute('data-testid') ?? '').replace('dm-item-', '')));
    expect(new Set(shown)).toEqual(expectedRoomIds);

    // Avatar or initials for each DM.
    await expect(dmItem(page, R.dmBob).locator('img, .u-avatar').first()).toBeVisible();
  });

  test('AC-A3-2 opening the Bob DM shows his name in the header and the first message', async ({ page }) => {
    await openHome(page);
    await dmItem(page, R.dmBob).click();
    await expect(page.getByTestId('channel-header-name')).toContainText(DISPLAY_NAMES.bob);
    await expect(messageList(page).getByText(BODIES.dmBob1)).toBeVisible({ timeout: 5_000 });
  });

  test('AC-A3-3 a DM hides the member list or shows only its two participants', async ({ page }) => {
    await openHome(page);
    await dmItem(page, R.dmBob).click();
    await expect(messageList(page)).toBeVisible();

    const list = page.getByTestId('member-list');
    if ((await list.count()) === 0) return; // hidden is allowed by the criterion
    const items = await list
      .locator('[data-testid^="member-item-"]')
      .evaluateAll((els) => els.map((el) => (el.getAttribute('data-testid') ?? '').replace('member-item-', '')));
    expect(new Set(items)).toEqual(new Set([ALICE, BOB]));
  });
});

test.describe('DEV-A-4 member list', () => {
  test('AC-A4-1 general lists all four members with display names and a count of 4', async ({ page }) => {
    const joined = await admin.joinedMembers(R.general);
    noteSeedDrift('AC-A4-1 (#general member count)', 4, Object.keys(joined).length);

    for (const [key, id] of [
      ['alice', ALICE],
      ['bob', BOB],
      ['carol', CAROL],
      ['dave', DAVE],
    ] as const) {
      const item = page.getByTestId(`member-item-${id}`);
      await expect(item, `${key} must be listed`).toBeVisible();
      await expect(item).toContainText(DISPLAY_NAMES[key]);
    }
    await expect(page.getByTestId('member-count')).toContainText(String(Object.keys(joined).length));
  });

  test('AC-A4-2 dev has three members and carol is absent', async ({ page }) => {
    await openChannel(page, R.dev);
    const joined = await admin.joinedMembers(R.dev);
    noteSeedDrift('AC-A4-2 (#dev member count)', 3, Object.keys(joined).length);

    await expect(page.getByTestId(`member-item-${ALICE}`)).toBeVisible();
    await expect(page.getByTestId(`member-item-${BOB}`)).toBeVisible();
    await expect(page.getByTestId(`member-item-${DAVE}`)).toBeVisible();
    await expect(page.getByTestId(`member-item-${CAROL}`)).toHaveCount(0);
    await expect(page.getByTestId('member-count')).toContainText(String(Object.keys(joined).length));
  });

  test('AC-A4-3 member-toggle hides and shows the member list', async ({ page }) => {
    await expect(page.getByTestId('member-list')).toBeVisible();
    await page.getByTestId('member-toggle').click();
    await expect(page.getByTestId('member-list')).toHaveCount(0);
    await page.getByTestId('member-toggle').click();
    await expect(page.getByTestId('member-list')).toBeVisible();
  });

  test('AC-A4-4 an invited-but-not-joined user appears under member-section-invited', async ({ page }) => {
    // #lobby has no carol in the seed, so inviting her there is reversible (cleaned up below).
    await revokePendingInvite(admin, [R.lobby], CAROL);
    await admin.invite(R.lobby, CAROL);
    try {
      await openSpace(page, R.gaming);
      await openChannel(page, R.lobby);
      await expect(page.getByTestId('member-section-invited')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId(`member-item-${CAROL}`)).toBeVisible({ timeout: 10_000 });
    } finally {
      await revokePendingInvite(admin, [R.lobby], CAROL);
    }
  });
});

test.describe('DEV-A-5 unread badges', () => {
  test('AC-A5-1 random carries a numeric unread badge and general/dev carry none', async ({ page }) => {
    const ensured = await ensureUnread(R.random, 3);
    noteSeedDrift('AC-A5-1 (#random unread)', 3, ensured.count);

    const badge = page.getByTestId(`channel-unread-${R.random}`);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => badgeCount(badge), { timeout: 10_000 }).toBe(ensured.count);
    await expect(badge).toContainText(String(ensured.count));

    for (const [name, roomId] of [
      [NAMES.general, R.general],
      [NAMES.dev, R.dev],
    ] as const) {
      const derived = (await admin.unreadFor(roomId)).count;
      noteSeedDrift(`AC-A5-1 (#${name} unread)`, 0, derived);
      if (derived === 0) {
        await expect(page.getByTestId(`channel-unread-${roomId}`)).toHaveCount(0);
      }
    }
  });

  test('AC-A5-2 the rail shows unread dots for Acme and Gaming; reading random clears the Acme dot', async ({
    page,
  }) => {
    await ensureUnread(R.random, 1);
    await ensureUnread(R.lobby, 1);

    await expect(page.getByTestId(`space-unread-${R.gaming}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`space-unread-${R.acme}`)).toBeVisible({ timeout: 10_000 });

    const otherAcmeUnread =
      (await admin.unreadFor(R.general)).count + (await admin.unreadFor(R.dev)).count;
    await openChannel(page, R.random);
    await expect(page.getByTestId(`channel-unread-${R.random}`)).toHaveCount(0, { timeout: 10_000 });

    if (otherAcmeUnread === 0) {
      await expect(page.getByTestId(`space-unread-${R.acme}`)).toHaveCount(0, { timeout: 10_000 });
    } else {
      annotate(
        'seed-drift',
        `AC-A5-2: #general/#dev carry ${otherAcmeUnread} unread on this homeserver, so the Acme rail dot is expected to stay. Run \`npm run seed:reset\` to assert the disappearance.`,
      );
    }
    // The Gaming dot is untouched by reading an Acme channel.
    await expect(page.getByTestId(`space-unread-${R.gaming}`)).toBeVisible();
  });

  test('AC-A5-3 opening a room clears its badge within 2 s and it stays gone after reload', async ({ page }) => {
    // Self-sufficient precondition: bob posts while alice is sitting in #general.
    await bob.send(R.random, `[qa] AC-A5-3 unread ${Date.now()}`);
    const badge = page.getByTestId(`channel-unread-${R.random}`);
    await expect(badge).toBeVisible({ timeout: 10_000 });

    await openChannel(page, R.random);
    await expect(badge).toHaveCount(0, { timeout: 2_500 });

    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`channel-unread-${R.random}`)).toHaveCount(0, { timeout: 10_000 });
  });

  test('AC-A5-4 a message posted in another channel raises its badge live, without reload', async ({ page }) => {
    await openChannel(page, R.random);
    await expect(page.getByTestId(`channel-unread-${R.random}`)).toHaveCount(0, { timeout: 10_000 });
    await openChannel(page, R.general);

    const before = (await admin.unreadFor(R.random)).count;
    await bob.send(R.random, `[qa] AC-A5-4 live badge ${Date.now()}`);

    const badge = page.getByTestId(`channel-unread-${R.random}`);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => badgeCount(badge), { timeout: 10_000 }).toBe(before + 1);
  });

  test('AC-A5-5 a DM message raises the DM badge; opening the DM clears it', async ({ page }) => {
    await openHome(page);
    await dmItem(page, R.dmBob).click();
    await expect(messageList(page)).toBeVisible();
    await expect(page.getByTestId(`dm-unread-${R.dmBob}`)).toHaveCount(0, { timeout: 10_000 });

    // Move off the DM so the app does not read it as the message arrives.
    await dmItem(page, R.dmCarol).click();
    await expect(messageList(page)).toBeVisible();

    await bob.send(R.dmBob, `[qa] AC-A5-5 dm badge ${Date.now()}`);
    const badge = page.getByTestId(`dm-unread-${R.dmBob}`);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => badgeCount(badge), { timeout: 10_000 }).toBe(1);

    await dmItem(page, R.dmBob).click();
    await expect(badge).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe('DEV-A-6 create channel', () => {
  test('AC-A6-1 channel-add opens the dialog with focus in the name field', async ({ page }) => {
    await openSpace(page, R.gaming);
    await page.getByTestId('channel-add').click();
    await expect(page.getByTestId('create-channel-dialog')).toBeVisible();
    await expect(page.getByTestId('create-channel-name')).toBeFocused();
  });

  test('AC-A6-2/AC-A6-3 creating a channel selects it, and bob sees it as a public unencrypted child', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openSpace(page, R.gaming);
    const name = uniqueName('memes');

    await page.getByTestId('channel-add').click();
    await page.getByTestId('create-channel-name').fill(name);
    await page.getByTestId('create-channel-topic').fill('Only the dankest');
    await page.getByTestId('create-channel-submit').click();

    await expect(page.getByTestId('create-channel-dialog')).toHaveCount(0, { timeout: 20_000 });
    const item = byName(page.getByTestId('channel-list'), name);
    await expectChannelListed(page, item, name);
    await expect(item).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('channel-header-name')).toContainText(name);
    await expect(page.getByTestId('channel-header-topic')).toContainText('Only the dankest');

    // AC-A6-3: as bob, the room is a child of Gaming, public and unencrypted.
    const roomId = (await item.getAttribute('data-testid'))!.replace('channel-item-', '');
    created.push({ roomId, parentSpaceId: R.gaming });

    await expect
      .poll(async () => (await bob.hierarchy(R.gaming)).rooms.some((r) => r.room_id === roomId), {
        timeout: 15_000,
        intervals: [500, 1_000],
      })
      .toBe(true);

    const child = (await bob.hierarchy(R.gaming)).rooms.find((r) => r.room_id === roomId)!;
    expect(child.join_rule, 'the new channel must be public').toBe('public');
    expect(await admin.stateEvent(roomId, 'm.room.encryption'), 'must be unencrypted').toBeUndefined();
    const parent = await admin.stateEvent(roomId, 'm.space.parent', R.gaming);
    expect(parent, 'm.space.parent must point at Gaming').toBeTruthy();
  });

  test('AC-A6-4 submit is disabled while the name is empty', async ({ page }) => {
    await openSpace(page, R.gaming);
    await page.getByTestId('channel-add').click();
    await expect(page.getByTestId('create-channel-submit')).toBeDisabled();
    await page.getByTestId('create-channel-name').fill('x');
    await expect(page.getByTestId('create-channel-submit')).toBeEnabled();
    await page.getByTestId('create-channel-name').fill('');
    await expect(page.getByTestId('create-channel-submit')).toBeDisabled();
  });
});

test.describe('DEV-A-7 invite user', () => {
  test('AC-A7-1 space-menu-invite opens the invite dialog', async ({ page }) => {
    await openSpace(page, R.gaming);
    await page.getByTestId('space-menu').click();
    await page.getByTestId('space-menu-invite').click();
    await expect(page.getByTestId('invite-dialog')).toBeVisible();
    await expect(page.getByTestId('invite-user-id')).toBeVisible();
  });

  test('AC-A7-2 inviting carol shows her under member-section-invited for the space channels', async ({ page }) => {
    test.setTimeout(60_000);
    const gamingRooms = [R.gaming, ...(await childRoomIds(admin, R.gaming))];
    await revokePendingInvite(admin, gamingRooms, CAROL);

    await openSpace(page, R.gaming);
    await page.getByTestId('space-menu').click();
    await page.getByTestId('space-menu-invite').click();
    await page.getByTestId('invite-user-id').fill(CAROL);
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId('invite-dialog')).toHaveCount(0, { timeout: 20_000 });

    await expect(page.getByTestId('member-section-invited')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`member-item-${CAROL}`)).toBeVisible({ timeout: 10_000 });
    expect(await admin.membership(R.gaming, CAROL)).toBe('invite');

    await revokePendingInvite(admin, gamingRooms, CAROL);
  });

  test('AC-A7-3 an unknown user shows the server error and keeps the dialog open', async ({ page }) => {
    await openSpace(page, R.gaming);
    await page.getByTestId('space-menu').click();
    await page.getByTestId('space-menu-invite').click();
    await page.getByTestId('invite-user-id').fill('@nobody:localhost');
    await page.getByTestId('invite-submit').click();

    await expect(page.getByTestId('invite-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('invite-error')).not.toBeEmpty();
    await expect(page.getByTestId('invite-dialog')).toBeVisible();
  });
});

test.describe('DEV-A-8 create space', () => {
  test('AC-A8-1 creating a space selects it and auto-creates one general channel', async ({ page }) => {
    test.setTimeout(90_000);
    const name = uniqueName('Design');

    await page.getByTestId('space-add').click();
    await expect(page.getByTestId('create-space-dialog')).toBeVisible();
    await page.getByTestId('create-space-name').fill(name);
    await page.getByTestId('create-space-submit').click();
    await expect(page.getByTestId('create-space-dialog')).toHaveCount(0, { timeout: 30_000 });

    const railItem = byName(page.getByTestId('space-rail'), name);
    await expect(railItem).toBeVisible({ timeout: 30_000 });
    await expect(railItem).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('space-header-name')).toHaveText(name);

    await expect
      .poll(() => itemNames(page.getByTestId('channel-list'), 'channel-item-'), { timeout: 30_000 })
      .toEqual([NAMES.general]);

    const spaceId = (await railItem.getAttribute('data-testid'))!.replace('space-item-', '');
    for (const childId of await childRoomIds(admin, spaceId)) {
      created.push({ roomId: childId, parentSpaceId: spaceId });
    }
    created.push({ roomId: spaceId });
  });
});

test.describe('DEV-A-9 new DM', () => {
  test('AC-A9-1 starting a DM with dave opens it, and repeating it reuses the same room', async ({ page }) => {
    test.setTimeout(90_000);
    await openHome(page);
    await page.getByTestId('dm-new').click();
    await expect(page.getByTestId('new-dm-dialog')).toBeVisible();
    await page.getByTestId('new-dm-user-id').fill(DAVE);
    await page.getByTestId('new-dm-submit').click();
    await expect(page.getByTestId('new-dm-dialog')).toHaveCount(0, { timeout: 30_000 });

    const item = byName(page.getByTestId('dm-list'), DISPLAY_NAMES.dave);
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('channel-header-name')).toContainText(DISPLAY_NAMES.dave, {
      timeout: 20_000,
    });
    const firstRoomId = (await item.getAttribute('data-testid'))!.replace('dm-item-', '');

    // Re-doing it must reuse the room rather than create a second one.
    await openHome(page);
    await page.getByTestId('dm-new').click();
    await page.getByTestId('new-dm-user-id').fill(DAVE);
    await page.getByTestId('new-dm-submit').click();
    await expect(page.getByTestId('new-dm-dialog')).toHaveCount(0, { timeout: 30_000 });

    await expect(byName(page.getByTestId('dm-list'), DISPLAY_NAMES.dave)).toHaveCount(1);
    await expect(dmItem(page, firstRoomId)).toBeVisible();
    await expect(page.getByTestId('channel-header-name')).toContainText(DISPLAY_NAMES.dave);
  });
});

