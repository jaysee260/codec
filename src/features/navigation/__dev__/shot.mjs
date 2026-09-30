/**
 * Throwaway Dev A verification script (not part of the app or the QA suite).
 *   node src/features/navigation/__dev__/shot.mjs [port] [outFile]
 *
 * Logs in as alice against a private dev server, walks every navigation surface, asserts the
 * data-testid contract from docs/ACCEPTANCE.md, writes screenshots, then undoes everything it
 * created (channel / space / DM / invites) so the shared seed is left exactly as it was.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const PORT = process.argv[2] ?? '5181';
const OUT = process.argv[3] ?? 'docs/screenshots/dev-a-nav.png';
const BASE = `http://localhost:${PORT}`;
const HS = process.env.HS_URL ?? 'http://localhost:8008';
const seed = JSON.parse(readFileSync('seed/seed-output.json', 'utf8'));
const R = seed.rooms;

mkdirSync('docs/screenshots', { recursive: true });

let failures = 0;
const check = async (label, fn) => {
  try {
    const value = await fn();
    const bad = value === false;
    if (bad) failures++;
    const extra = value === true || value === false ? '' : ` -> ${value}`;
    console.log(`${bad ? 'FAIL' : 'ok  '} ${label}${extra}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${label} -> ${String(e.message).split('\n')[0]}`);
  }
};

// --------------------------------------------------------------------------- admin http helpers
let token = null;
const api = async (method, path, body) => {
  const res = await fetch(`${HS}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
};
const loginAdmin = async () => {
  const res = await fetch(`${HS}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'password123',
    }),
  });
  token = (await res.json()).access_token;
};
const enc = (id) => encodeURIComponent(id);
const dropChild = (spaceId, childId) => api('PUT', `/_matrix/client/v3/rooms/${enc(spaceId)}/state/m.space.child/${enc(childId)}`, {});
const leaveForget = async (roomId) => {
  await api('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/leave`, {});
  await api('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/forget`, {});
};
const kick = (roomId, userId) => api('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/kick`, { user_id: userId, reason: 'dev-a cleanup' });
const hierarchy = async (spaceId) => (await api('GET', `/_matrix/client/v1/rooms/${enc(spaceId)}/hierarchy?limit=50`)).json.rooms ?? [];

const created = { channelId: null, spaceId: null, dmRoomId: null, invitedTo: [] };

// --------------------------------------------------------------------------- browser
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' && !/rtc\/transports|404 \(Not Found\)/.test(m.text())) {
    console.log('  console.error:', m.text().slice(0, 200));
  }
});
const idByName = (container, name) =>
  page
    .getByTestId(container)
    .locator(`[data-name="${name}"]`)
    .first()
    .getAttribute('data-testid');
const names = async (container) =>
  (await page.getByTestId(container).locator('[data-name]').evaluateAll((els) => els.map((e) => e.dataset.name))).join(' | ');

try {
  await loginAdmin();

  await page.goto(BASE);
  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill('password123');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('app-shell').waitFor({ timeout: 40000 });
  await page.getByTestId(`channel-item-${R.general}`).waitFor({ timeout: 25000 });
  await page.waitForTimeout(2500);

  console.log('\n--- first load: AC-A1 / A2 / A4 / A5 ---');
  await check('AC-A1-1 rail order', () => names('space-rail'));
  await check('AC-A1-2 Acme HQ selected', () => page.getByTestId(`space-item-${R['acme-hq']}`).getAttribute('data-selected'));
  await check('AC-A1-5 space title attr', () => page.getByTestId(`space-item-${R.gaming}`).getAttribute('title'));
  await check('AC-A2-1 channel order', () => names('channel-list'));
  await check('AC-A2-1 # prefix', () => page.getByTestId(`channel-item-${R.general}`).innerText().then((t) => JSON.stringify(t)));
  await check('AC-A2-2 header name', () => page.getByTestId('channel-header-name').innerText());
  await check('AC-A2-2 header topic', () => page.getByTestId('channel-header-topic').innerText());
  await check('AC-A4-1 member-count', () => page.getByTestId('member-count').innerText());
  await check('AC-A4-1 member items', async () => {
    const out = [];
    for (const id of ['@alice:localhost', '@bob:localhost', '@carol:localhost', '@dave:localhost']) {
      out.push(`${id.slice(1, 6)}=${await page.getByTestId(`member-item-${id}`).count()}`);
    }
    return out.join(' ');
  });
  await check('AC-A5-1 random badge', () => page.getByTestId(`channel-unread-${R.random}`).getAttribute('data-count'));
  await check('AC-A5-1 general no badge', async () => (await page.getByTestId(`channel-unread-${R.general}`).count()) === 0);
  await check('AC-A5-2 acme rail badge', () => page.getByTestId(`space-unread-${R['acme-hq']}`).getAttribute('data-count'));
  await check('AC-A5-2 gaming rail badge', () => page.getByTestId(`space-unread-${R.gaming}`).getAttribute('data-count'));
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-1-general.png' });

  console.log('\n--- member toggle + #dev ---');
  await page.getByTestId('member-toggle').click();
  await check('AC-A4-3 member-list hidden', async () => (await page.getByTestId('member-list').count()) === 0);
  await page.getByTestId('member-toggle').click();
  await check('AC-A4-3 member-list back', () => page.getByTestId('member-list').isVisible());
  await page.getByTestId(`channel-item-${R.dev}`).click();
  await page.waitForTimeout(1800);
  await check('AC-A4-2 dev member-count', () => page.getByTestId('member-count').innerText());
  await check('AC-A4-2 carol absent', async () => (await page.getByTestId('member-item-@carol:localhost').count()) === 0);

  console.log('\n--- Gaming (AC-A1-3) ---');
  await page.getByTestId(`space-item-${R.gaming}`).click();
  await page.waitForTimeout(900);
  await check('AC-A1-3 space-header-name', () => page.getByTestId('space-header-name').innerText());
  await check('AC-A1-3 gaming channels', () => names('channel-list'));
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-2-gaming.png' });

  console.log('\n--- Home / DMs (AC-A1-4, AC-A3) ---');
  await page.getByTestId('space-item-home').click();
  await page.waitForTimeout(1500);
  await check('AC-A1-4 dm-list visible', () => page.getByTestId('dm-list').isVisible());
  await check('AC-A1-4 channel-list gone', async () => (await page.getByTestId('channel-list').count()) === 0);
  await check('AC-A3-1 dm names', () => names('dm-list'));
  await page.getByTestId(`dm-item-${R['dm-alice-bob']}`).click();
  await page.waitForTimeout(1500);
  await check('AC-A3-2 dm header name', () => page.getByTestId('channel-header-name').innerText());
  await check('AC-A3-3 member-list hidden for DM', async () => (await page.getByTestId('member-list').count()) === 0);
  await check('AC-A3-3 member-toggle hidden for DM', async () => (await page.getByTestId('member-toggle').count()) === 0);
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-3-dms.png' });

  console.log('\n--- Alt+Arrow channel cycling (DEV-A-10) ---');
  await page.getByTestId(`space-item-${R['acme-hq']}`).click();
  await page.waitForTimeout(700);
  const before = await page.getByTestId('channel-header-name').innerText();
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(600);
  const after = await page.getByTestId('channel-header-name').innerText();
  await check('Alt+ArrowDown moves channel', () => `${before} -> ${after}`);

  if (process.env.SKIP_WRITES) {
    console.log('\n--- SKIP_WRITES=1: dialogs not exercised ---');
    await page.getByTestId(`channel-item-${R.general}`).click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: OUT });
    console.log(`wrote ${OUT}`);
    throw { skip: true };
  }

  console.log('\n--- create channel (AC-A6) ---');
  await page.getByTestId(`space-item-${R.gaming}`).click();
  await page.waitForTimeout(700);
  await page.getByTestId('channel-add').click();
  await check('AC-A6-1 dialog open', () => page.getByTestId('create-channel-dialog').isVisible());
  await check('AC-A6-1 name focused', () => page.getByTestId('create-channel-name').evaluate((el) => el === document.activeElement));
  await check('AC-A6-4 submit disabled when empty', () => page.getByTestId('create-channel-submit').isDisabled());
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-4-create-channel.png' });
  const chanName = `memes-${Date.now().toString().slice(-6)}`;
  await page.getByTestId('create-channel-name').fill('Memes Test');
  await check('AC-A6 name slugified', () => page.getByTestId('create-channel-name').inputValue());
  await page.getByTestId('create-channel-name').fill(chanName);
  await page.getByTestId('create-channel-topic').fill('Only the dankest');
  await page.getByTestId('create-channel-submit').click();
  await page.getByTestId('create-channel-dialog').waitFor({ state: 'detached', timeout: 30000 });
  await page.waitForTimeout(2500);
  await check('AC-A6-2 new channel selected', () => page.getByTestId('channel-header-name').innerText());
  await check('AC-A6-2 new channel topic', () => page.getByTestId('channel-header-topic').innerText());
  created.channelId = (await idByName('channel-list', chanName))?.replace('channel-item-', '') ?? null;
  await check('AC-A6-2 new channel in list', () => !!created.channelId);
  await check('AC-A6-3 child of Gaming', async () => {
    const kids = await hierarchy(R.gaming);
    return kids.some((r) => r.room_id === created.channelId) ? 'yes' : false;
  });

  console.log('\n--- invite (AC-A7) ---');
  await page.getByTestId('space-menu').click();
  await page.getByTestId('space-menu-invite').click();
  await check('AC-A7-1 invite dialog open', () => page.getByTestId('invite-dialog').isVisible());
  await page.getByTestId('invite-user-id').fill('@nobody:localhost');
  await page.getByTestId('invite-submit').click();
  await page.getByTestId('invite-error').waitFor({ timeout: 20000 });
  await check('AC-A7-3 invite-error text', () => page.getByTestId('invite-error').innerText());
  await check('AC-A7-3 dialog still open', () => page.getByTestId('invite-dialog').isVisible());
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-5-invite-error.png' });
  await page.getByTestId('invite-user-id').fill('@carol:localhost');
  await page.getByTestId('invite-submit').click();
  await page.getByTestId('invite-dialog').waitFor({ state: 'detached', timeout: 30000 });
  created.invitedTo = [R.gaming, R.lobby, created.channelId].filter(Boolean);
  await page.waitForTimeout(3000);
  await check('AC-A7-2 carol under invited', async () => {
    const section = await page.getByTestId('member-section-invited').count();
    const carol = await page.getByTestId('member-item-@carol:localhost').count();
    return section > 0 && carol > 0 ? 'yes' : `section=${section} carol=${carol}`;
  });
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-6-invited.png' });

  console.log('\n--- dialog close behaviour ---');
  await page.getByTestId('space-add').click();
  await check('create-space dialog opens', () => page.getByTestId('create-space-dialog').isVisible());
  await page.keyboard.press('Escape');
  await check('Escape closes dialog', async () => (await page.getByTestId('create-space-dialog').count()) === 0);
  await page.getByTestId('space-add').click();
  await page.getByTestId('dialog-close').click();
  await check('dialog-close closes dialog', async () => (await page.getByTestId('create-space-dialog').count()) === 0);

  console.log('\n--- create space (AC-A8) ---');
  const spaceName = `DevA Check ${Date.now().toString().slice(-6)}`;
  await page.getByTestId('space-add').click();
  await page.getByTestId('create-space-name').fill(spaceName);
  await page.getByTestId('create-space-submit').click();
  await page.getByTestId('create-space-dialog').waitFor({ state: 'detached', timeout: 30000 });
  await page.waitForTimeout(4000);
  created.spaceId = (await idByName('space-rail', spaceName))?.replace('space-item-', '') ?? null;
  await check('AC-A8-1 rail item exists', () => !!created.spaceId);
  await check('AC-A8-1 rail item selected', () => page.getByTestId(`space-item-${created.spaceId}`).getAttribute('data-selected'));
  await check('AC-A8-1 auto general channel', () => names('channel-list'));
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-8-new-space.png' });

  console.log('\n--- new DM (AC-A9) ---');
  await page.getByTestId('space-item-home').click();
  await page.waitForTimeout(800);
  await page.getByTestId('dm-new').click();
  await check('AC-A9-1 new-dm dialog', () => page.getByTestId('new-dm-dialog').isVisible());
  await page.getByTestId('new-dm-user-id').fill('@dave:localhost');
  await page.getByTestId('new-dm-submit').click();
  await page.getByTestId('new-dm-dialog').waitFor({ state: 'detached', timeout: 35000 });
  await page.waitForTimeout(2500);
  await check('AC-A9-1 Dave in dm-list', () => page.getByTestId('dm-list').getByText('Dave Okafor').count().then((n) => n > 0));
  await check('AC-A9-1 header is Dave', () => page.getByTestId('channel-header-name').innerText());
  created.dmRoomId = (await idByName('dm-list', 'Dave Okafor'))?.replace('dm-item-', '') ?? null;
  await page.screenshot({ path: 'docs/screenshots/dev-a-nav-7-new-dm.png' });

  console.log('\n--- unread clears after opening (AC-A5-3) ---');
  await page.getByTestId(`space-item-${R['acme-hq']}`).click();
  await page.waitForTimeout(700);
  await check('AC-A5-3 random badge present before', () => page.getByTestId(`channel-unread-${R.random}`).count().then((n) => n > 0));
  await page.getByTestId(`channel-item-${R.random}`).click();
  await page.waitForTimeout(5000);
  await check('AC-A5-3 random badge cleared', async () => (await page.getByTestId(`channel-unread-${R.random}`).count()) === 0);

  console.log('\n--- hero screenshot ---');
  await page.getByTestId(`channel-item-${R.general}`).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT });
  console.log(`wrote ${OUT}`);
} catch (e) {
  if (!e?.skip) {
    failures++;
    console.log('SCRIPT ERROR:', e?.message ?? e);
  }
} finally {
  await browser.close();

  // ----------------------------------------------------------------------- cleanup
  console.log('\n--- cleanup (restore the shared seed) ---');
  try {
    if (!token) await loginAdmin();
    for (const roomId of created.invitedTo) {
      const res = await kick(roomId, '@carol:localhost');
      console.log(`  uninvite carol from ${roomId}: ${res.status}`);
    }
    if (created.channelId) {
      console.log(`  drop m.space.child ${created.channelId}: ${(await dropChild(R.gaming, created.channelId)).status}`);
      await leaveForget(created.channelId);
      console.log('  left + forgot created channel');
    }
    if (created.spaceId) {
      for (const child of await hierarchy(created.spaceId)) {
        if (child.room_id === created.spaceId) continue;
        await dropChild(created.spaceId, child.room_id);
        await leaveForget(child.room_id);
      }
      await leaveForget(created.spaceId);
      console.log('  left + forgot created space and its children');
    }
    if (created.dmRoomId) {
      const direct = (await api('GET', `/_matrix/client/v3/user/${enc('@alice:localhost')}/account_data/m.direct`)).json;
      const next = {};
      for (const [user, ids] of Object.entries(direct)) {
        const kept = (ids ?? []).filter((id) => id !== created.dmRoomId);
        if (kept.length) next[user] = kept;
      }
      const put = await api('PUT', `/_matrix/client/v3/user/${enc('@alice:localhost')}/account_data/m.direct`, next);
      await leaveForget(created.dmRoomId);
      console.log(`  m.direct restored (${put.status}), left + forgot the dave DM`);
    }
    const gaming = (await hierarchy(R.gaming)).map((r) => r.name).join(', ');
    console.log(`  gaming hierarchy now: ${gaming}`);
  } catch (e) {
    console.log('  CLEANUP FAILED:', e.message);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
}
