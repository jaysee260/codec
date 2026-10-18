/**
 * Phase 5 QA-26: encrypted attachments (AC-E3). Desktop, sequential, alice-A in `page` + bob-B in a second
 * context, both in `#vault`.
 *
 * Every send is checked three ways: the decrypted content the app holds (dev hook), the wire (`m.room.encrypted`,
 * no plaintext) and the media repo (ciphertext: not the file's magic bytes, SHA-256 = `file.hashes.sha256`).
 * AC-E3-5 forges a plaintext `m.image` with a bad `file` hash through the API (the API cannot encrypt; the
 * criterion is about the decrypt path, not the wire). AC-E3-7 (Element-sent media) is manual: docs/BUGS.md.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { resolveRoom, userId } from './fixtures/seed.ts';
import { channelItem, messageList, openChannel, openSpace, row } from './fixtures/ui.ts';
import { PNG_SIGNATURE, expectEncryptedOnWire, rawEvent, rawMediaBytes, sendRaw, sha256b64, startsWith } from './fixtures/e2ee-api.ts';
import { e2eeAfterEach, loginWith, secondContext, uiHalf, requireUi, waitForEventState, waitForStatus, type SecondContext } from './fixtures/e2ee.ts';

test.describe.configure({ timeout: 150_000 });

const R = { vault: '', acme: '' };
let alice: ApiUser;
let bob: ApiUser;
const IMAGE = 'e2e/fixtures/test-image.png';
const FILE = 'e2e/fixtures/test-file.txt';
const IMAGE_W = 120;
const IMAGE_H = 80;

test.beforeAll(async () => {
  R.vault = await resolveRoom('vault');
  R.acme = await resolveRoom('acme-hq');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
});

async function openVault(page: Page): Promise<void> {
  if (!(await channelItem(page, R.vault).isVisible().catch(() => false))) await openSpace(page, R.acme);
  await openChannel(page, R.vault);
}

async function aliceAndBob(page: Page, browser: import('@playwright/test').Browser): Promise<SecondContext> {
  await loginWith(page, 'alice');
  await waitForStatus(page);
  await openVault(page);
  const b = await secondContext(browser, 'bob');
  await waitForStatus(b.page);
  await openVault(b.page);
  return b;
}

/** The newest row from alice that has `testid` inside, settled. */
async function newestAliceRowWith(page: Page, testid: string, notIn: string[] = []): Promise<string> {
  const rows = messageList(page).locator(`[data-testid^="message-$"][data-sender="${userId('alice')}"]`).filter({ has: page.getByTestId(testid) });
  await expect.poll(async () => {
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('message-', '')));
    return ids.filter((id) => !notIn.includes(id)).length;
  }, { timeout: 30_000, message: `a new alice row with ${testid}` }).toBeGreaterThan(0);
  const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('message-', '')));
  return ids.filter((id) => !notIn.includes(id)).pop()!;
}

async function rowIdsWith(page: Page, testid: string): Promise<string[]> {
  return messageList(page)
    .locator('[data-testid^="message-"]')
    .filter({ has: page.getByTestId(testid) })
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('message-', '')));
}

/** AC-E3-1/3/4 shared: decrypted `file` shape, no url / thumbnails, ciphertext on the media repo. */
async function expectEncryptedMedia(content: Record<string, any>, plain: Uint8Array | null, magic: number[] | null, label: string): Promise<Uint8Array> {
  expect(content.url, `${label}: no top-level url`).toBeUndefined();
  const f = content.file;
  expect(f, `${label}: file`).toBeTruthy();
  expect(f.v).toBe('v2');
  expect(f.url).toMatch(/^mxc:\/\//);
  expect(f.key).toMatchObject({ alg: 'A256CTR', kty: 'oct', ext: true });
  expect(f.key.key_ops).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
  expect(f.key.k).toMatch(/^[A-Za-z0-9_-]+$/);
  const iv = Buffer.from(f.iv, 'base64');
  expect(iv.length, `${label}: iv is 16 bytes`).toBe(16);
  expect([...iv.subarray(8)], `${label}: low 8 iv bytes zero`).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect(content.info?.thumbnail_url, `${label}: no thumbnail_url`).toBeUndefined();
  expect(content.info?.thumbnail_file, `${label}: no thumbnail_file`).toBeUndefined();
  const bytes = await rawMediaBytes(alice.token, f.url);
  expect(sha256b64(bytes), `${label}: SHA-256 of the stored bytes`).toBe(f.hashes.sha256);
  if (magic) expect(startsWith(bytes, magic), `${label}: stored bytes must not start with the file's magic`).toBe(false);
  if (plain) {
    expect(bytes.length, `${label}: CTR keeps the length`).toBe(plain.length);
    expect(Buffer.from(bytes).equals(Buffer.from(plain)), `${label}: stored bytes differ from the plaintext`).toBe(false);
  }
  return bytes;
}

test('AC-E3-1 + AC-E3-2 encrypted image: contract shape, ciphertext on the server, blob render on both sides', async ({ page, browser }) => {
  const b = await aliceAndBob(page, browser);
  {
    const before = await rowIdsWith(page, 'message-image');
    await page.getByTestId('composer-file-input').setInputFiles(IMAGE);
    const id = await newestAliceRowWith(page, 'message-image', before);

    expectEncryptedOnWire(await rawEvent(alice.token, R.vault, id), { label: 'image' });
    const st = await waitForEventState(page, R.vault, id, (s) => s.content?.msgtype === 'm.image', 'decrypted m.image');
    const c = st.content!;
    expect(c.info).toMatchObject({ mimetype: 'image/png', w: IMAGE_W, h: IMAGE_H });
    expect(c.info.size).toBe(readFileSync(IMAGE).length);
    await expectEncryptedMedia(c, new Uint8Array(readFileSync(IMAGE)), PNG_SIGNATURE, 'image');

    await uiHalf('Dev B', ['message-image-error'], async () => {
      for (const p of [page, b.page]) {
        const img = row(p, id).getByTestId('message-image');
        await expect(img).toHaveAttribute('data-encrypted', 'true', { timeout: 10_000 });
        await expect(img).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
        expect(await img.getAttribute('src')).toMatch(/^blob:/);
        await expect.poll(() => img.evaluate((e) => [(e as HTMLImageElement).naturalWidth, (e as HTMLImageElement).naturalHeight])).toEqual([IMAGE_W, IMAGE_H]);
      }
      // click opens the decrypted image, never the raw mxc
      const popup = page.waitForEvent('popup');
      await row(page, id).getByTestId('message-image').click();
      const tab = await popup;
      await tab.waitForURL(/^blob:/, { timeout: 10_000 });
      expect(tab.url()).not.toContain('/_matrix/');
      await tab.close();
    });
  }
  await b.close();
});

test('AC-E3-3 encrypted file: m.file with file, bob downloads the original bytes', async ({ page, browser }) => {
  const b = await aliceAndBob(page, browser);
  {
    const before = await rowIdsWith(page, 'message-file');
    await page.getByTestId('composer-file-input').setInputFiles(FILE);
    const id = await newestAliceRowWith(page, 'message-file', before);
    expectEncryptedOnWire(await rawEvent(alice.token, R.vault, id), { label: 'file' });
    const st = await waitForEventState(page, R.vault, id, (s) => s.content?.msgtype === 'm.file', 'decrypted m.file');
    const plain = new Uint8Array(readFileSync(FILE));
    await expectEncryptedMedia(st.content!, plain, [...plain.subarray(0, 8)], 'file');

    await uiHalf('Dev B', ['message-image-error'], async () => {
      const card = row(b.page, id).getByTestId('message-file');
      await expect(card).toHaveAttribute('data-encrypted', 'true', { timeout: 15_000 });
      expect(await card.getAttribute('href'), 'no link to the mxc').toBeNull();
      const download = b.page.waitForEvent('download');
      await card.click();
      const dl = await download;
      const path = await dl.path();
      expect(Buffer.from(readFileSync(path!)).equals(Buffer.from(plain)), 'downloaded bytes = fixture').toBe(true);
    });
  }
  await b.close();
});

test('AC-E3-4 encrypted voice note: Phase 2 shape with file in both places, ciphertext, bob plays it', async ({ page, browser }) => {
  const b = await aliceAndBob(page, browser);
  {
    const before = await rowIdsWith(page, 'voice-message');
    await page.getByTestId('composer-mic').click();
    await expect(page.getByTestId('composer-recording')).toHaveAttribute('data-state', 'recording', { timeout: 5_000 });
    await expect(page.getByTestId('recording-timer')).toHaveText('0:03', { timeout: 10_000 });
    await page.getByTestId('recording-send').click();
    const id = await newestAliceRowWith(page, 'voice-message', before);

    expectEncryptedOnWire(await rawEvent(alice.token, R.vault, id), { label: 'voice' });
    const st = await waitForEventState(page, R.vault, id, (s) => s.content?.msgtype === 'm.audio', 'decrypted m.audio');
    const c = st.content!;
    expect(c['org.matrix.msc3245.voice'], 'voice marker').toBeDefined();
    expect(c['org.matrix.msc1767.audio']?.waveform?.length).toBeGreaterThan(0);
    const inner = c['org.matrix.msc1767.file'];
    expect(inner?.file, 'file inside org.matrix.msc1767.file').toEqual(c.file);
    expect(inner?.url).toBeUndefined();
    await expectEncryptedMedia(c, null, [0x1a, 0x45, 0xdf, 0xa3], 'voice'); // webm/EBML magic

    await uiHalf('Dev B', ['voice-error'], async () => {
      const bubble = row(b.page, id).getByTestId('voice-message');
      await expect(bubble).toHaveAttribute('data-encrypted', 'true', { timeout: 15_000 });
      await bubble.getByTestId('voice-play').click();
      await expect(bubble.getByTestId('voice-pause')).toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => Number(await bubble.getByTestId('voice-progress').getAttribute('aria-valuenow')), { timeout: 10_000 }).toBeGreaterThan(0);
    });
  }
  await b.close();
});

test('AC-E3-5 an image whose hash does not match shows message-image-error and renders nothing', async ({ page }) => {
  requireUi('Dev B', 'message-image-error');
  await loginWith(page, 'alice');
  await waitForStatus(page);
  await openVault(page);
  // Real ciphertext from a fresh encrypted upload, then a lie about its hash.
  const forged = await page.evaluate(async () => {
    const w = (window as any).__matrixPoc;
    const png = await (await fetch('/favicon.svg').catch(() => null))?.arrayBuffer();
    const bytes = png && png.byteLength ? png : new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const { data, info } = await w.attachments.encryptAttachment(bytes);
    const url = await w.actions.uploadMedia(new Blob([data], { type: 'application/octet-stream' }), { type: 'application/octet-stream' });
    return { ...info, url, hashes: { sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } };
  });
  const id = await sendRaw(bob.token, R.vault, 'm.room.message', { msgtype: 'm.image', body: 'forged.png', info: { mimetype: 'image/png', w: 64, h: 64, size: 8 }, file: forged });
  const img = row(page, id).getByTestId('message-image');
  await expect(img).toHaveAttribute('data-state', 'error', { timeout: 15_000 });
  await expect(row(page, id).getByTestId('message-image-error')).toBeVisible();
  await expect(row(page, id).locator('img[src^="blob:"]'), 'nothing rendered from the bytes').toHaveCount(0);
  await expect(row(page, id).getByTestId('message-image').locator('img')).toHaveCount(0);
});

test('AC-E3-6 an encrypted image out of view is not downloaded until scrolled in, and does not shift (P1)', async ({ page, browser }) => {
  requireUi('Dev B', 'message-image-error');
  // bob's device must exist before alice posts (else he cannot decrypt), but must not be looking at #vault.
  const b = await secondContext(browser, 'bob');
  await waitForStatus(b.page);
  const fetched: string[] = [];
  let mediaId = '';
  b.page.on('request', (r) => {
    if (mediaId && r.url().includes(mediaId)) fetched.push(r.url());
  });

  await loginWith(page, 'alice');
  await waitForStatus(page);
  await openVault(page);
  const before = await rowIdsWith(page, 'message-image');
  await page.getByTestId('composer-file-input').setInputFiles(IMAGE);
  const id = await newestAliceRowWith(page, 'message-image', before);
  const st = await waitForEventState(page, R.vault, id, (s) => s.content?.msgtype === 'm.image', 'decrypted m.image');
  mediaId = String(st.content!.file.url).split('/').pop()!;
  const tag = Date.now().toString(36);
  // 20 texts after it (AC-E3-6), four lines each so they really push the image out of the preload margin.
  for (let i = 1; i <= 20; i += 1) {
    await page.evaluate(([r, t]) => (window as any).__matrixPoc.actions.sendText(r, t), [R.vault, `[qa] AC-E3-6 ${tag} filler ${i}\nline two\nline three\nline four`] as const);
  }
  await expect(messageList(page).getByText(`AC-E3-6 ${tag} filler 20`)).toBeVisible({ timeout: 20_000 });

  await openVault(b.page);
  await expect(messageList(b.page).getByText(`AC-E3-6 ${tag} filler 20`)).toBeVisible({ timeout: 20_000 });
  await b.page.waitForTimeout(2_000);
  const target = row(b.page, id);
  const inView = await target
    .evaluate((el) => {
      const list = document.querySelector('[data-testid="message-list"]')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.bottom > list.top - 200 && r.top < list.bottom + 200;
    })
    .catch(() => false);
  test.skip(inView, 'the image is still within the preload margin at this viewport; nothing to judge');
  expect(fetched, 'no download before the row is near the viewport').toEqual([]);
  const box = await target.getByTestId('message-image').boundingBox();
  await target.scrollIntoViewIfNeeded();
  await expect(target.getByTestId('message-image')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  expect(fetched.length).toBeGreaterThan(0);
  const after = await target.getByTestId('message-image').boundingBox();
  expect(Math.abs((after?.height ?? 0) - (box?.height ?? 0)), 'placeholder height = image height').toBeLessThanOrEqual(1);
  expect(Math.abs((after?.width ?? 0) - (box?.width ?? 0))).toBeLessThanOrEqual(1);
  await b.close();
});
