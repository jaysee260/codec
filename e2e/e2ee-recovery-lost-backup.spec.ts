/**
 * Recovery when the key backup secret is unreachable (production, JC 2026-10-18). Desktop.
 *
 * JC's account: `m.megolm_backup.v1` is encrypted under an old secret-storage key nobody has. JC's verified
 * Element device still holds the old room keys and the cross-signing private keys. Question: after the way out,
 * does the NEW key backup receive every room key that device holds (including keys already in the OLD backup
 * version), so a fresh Codec device that unlocks with the NEW recovery key reads the old messages?
 *
 *  1. JC's exact path, Element "change recovery key" (ChangeRecoveryKeyBody): new secret storage + resetKeyBackup.
 *     Passes: every secret under the new key, the new backup gets all keys, B (Codec UI) restores everything.
 *  2. FINDING (test.fixme): Element "Forgot recovery key?" = `resetEncryption` + new secret storage. The new backup
 *     gets every key, but the device holds no cross-signing private keys right after `resetEncryption` (the new
 *     master key is on the server), so the new secret storage has no cross-signing secrets and Codec's unlock with
 *     the new key fails at verification ("Content is not encrypted!").
 *  3. FINDING (test.fixme): Codec's own `setupRecovery({ reset: true })` asks for the OLD default key (Rust
 *     `resetCrossSigning` exports to the existing secret storage first), so it cannot help without that key.
 *  4. Import of an Element key export file (recovery-import) on a verified device whose backup is locked.
 *  5. JC after "change recovery key" left the backup behind: delete the backup, reload, "Allow key storage" on A
 *     (plain / stale backup key + m.key_backup disabled); B unlocks with the current key.
 *     5b. Same with A's sessions already marked backed up to the deleted version: the toggle alone uploads none of
 *     them to the new version (FINDING, recorded); a second `resetKeyBackup` does.
 *  6. JC's state: a normal unlock with the current key ends in E2 (`locked`, no-key), never in `prompt`.
 *  7. Review O1 / O2b (emoji match with the backup locked: Done only closes, no banner for ~10 s, then E2) and O3
 *     (emoji-verified, identity secrets under an old key, backup under the default key: the current key -> done).
 *  8. JC fixes it on W, the Element device that created the backup (key cached): RecoveryPanelOutOfSync "Enter
 *     recovery key" re-stores the backup secret under the current key, no reset, no delete; B and a reloaded,
 *     already verified Codec device restore with the current key. Stale cached key: fails safely, nothing changes.
 *
 * Seeding for 2/3: A sets up recovery (default key) and sends history (backup v1); the backup secret is re-stored
 * under a second key only and that key is thrown away; A's secret-storage key cache is cleared. A keeps its room
 * keys (and its old backup key: the SDK cannot forget it; the reset does not need it). Seeding for 1: see the test.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { channelItem, openChannel, openSpace, row, rowByText, settledEventId, typeAndSend } from './fixtures/ui.ts';
import { accountData, createRoom, defaultSecretStorageKey, deleteKeyBackupVersion, freshUser, keyBackup } from './fixtures/e2ee-api.ts';
import {
  RECOVERY_KEY_RE,
  cryptoApiCall,
  cryptoState,
  e2eeAfterEach,
  expectUtd,
  closeDialog,
  loginWith,
  openSecurityDialog,
  sameEmoji,
  secondContext,
  setupViaStore,
  unlockWith,
  waitForCrypto,
  waitForStatus,
  watchRecoveryPhases,
  type Account,
} from './fixtures/e2ee.ts';
import { annotate } from './fixtures/state.ts';
import { encryptMegolmKeyExport } from '../src/lib/matrix/key-export.ts';

test.describe.configure({ timeout: 300_000 });

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
});

/** Annotation + a console line (the list reporter prints test stdout), so timings show in CI logs too. */
function note(type: string, description: string): void {
  annotate(type, description);
  console.log(`[${type}] ${description}`);
}

async function openRoom(page: Page, u: { roomId: string; spaceId: string }): Promise<void> {
  if (!(await channelItem(page, u.roomId).isVisible().catch(() => false))) await openSpace(page, u.spaceId);
  await openChannel(page, u.roomId);
}

type ResetPath = 'element' | 'codec';

interface ResetOutcome {
  key: string | null;
  error: string | null;
  prompts: string[];
}

/**
 * Element's "Forgot recovery key?" (reset identity): `resetEncryption` (deletes every backup version and the
 * secret storage, new cross-signing, new backup), then new recovery (`bootstrapSecretStorage` with a new key,
 * which also stores the new backup key in it).
 */
async function resetLikeElement(a: Page, password: string, userId: string): Promise<ResetOutcome> {
  return a.evaluate(
    async ([pw, user]) => {
      const w = (window as any).__matrixPoc;
      const api = w.getClient().getCrypto();
      const store = w.security.store;
      const prompts: string[] = [];
      const off = store.subscribe((s: any) => {
        if (!s.prompt) return;
        prompts.push(s.prompt.kind);
        setTimeout(() => store.getState().answerPrompt(null), 0);
      });
      const uia = async (makeRequest: (auth: unknown) => Promise<unknown>): Promise<void> => {
        try {
          await makeRequest(null);
        } catch (e: any) {
          const session = e?.data?.session;
          if (!session) throw e;
          await makeRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: pw, session });
        }
      };
      try {
        await api.resetEncryption(uia);
        // FINDING 2: are the new cross-signing private keys still on the device?
        const cs = (await api.getCrossSigningStatus()).privateKeysCachedLocally;
        prompts.push(`csCachedAfterResetEncryption=${cs.masterKey && cs.selfSigningKey && cs.userSigningKey}`);
        let generated: { encodedPrivateKey?: string } | undefined;
        await api.bootstrapSecretStorage({
          setupNewSecretStorage: true,
          createSecretStorageKey: async () => (generated = await api.createRecoveryKeyFromPassphrase()),
        });
        await api.checkKeyBackupAndEnable();
        await store.getState().refresh();
        return { key: generated?.encodedPrivateKey ?? null, error: null, prompts };
      } catch (e) {
        return { key: null, error: e instanceof Error ? e.message : String(e), prompts };
      } finally {
        off();
      }
    },
    [password, userId] as const,
  );
}

/** Codec's own reset: `setupRecovery({ reset: true })` through the store (the locked dialog's "Reset backup"). */
async function resetLikeCodec(a: Page, password: string): Promise<ResetOutcome> {
  return a.evaluate(async (pw) => {
    const store = (window as any).__matrixPoc.security.store;
    const prompts: string[] = [];
    const off = store.subscribe((s: any) => {
      if (!s.prompt) return;
      prompts.push(s.prompt.kind);
      // Password for the cross-signing UIA; a recovery-key prompt means the reset wants the OLD key: refuse it.
      setTimeout(() => store.getState().answerPrompt(s.prompt?.kind === 'password' ? pw : null), 0);
    });
    try {
      const key = await store.getState().setupRecovery({ reset: true });
      return { key: key as string | null, error: store.getState().recovery.error as string | null, prompts };
    } finally {
      off();
    }
  }, password);
}

/** Seeds (see the header), resets A by `path`, waits for the new backup, then B unlocks with the new key (UI). */
async function resetScenario(page: Page, browser: Browser, path: ResetPath): Promise<void> {
  const t0 = Date.now();
  const lap = (label: string): void => note('timing', `${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const u = await freshUser(`qareset${path}`);
  const spaceId = await createRoom(u.token, { name: 'QA reset', space: true });
  const roomId = await createRoom(u.token, { name: 'secrets', encrypted: true, spaceId });
  const acct: Account = { username: u.username, password: u.password, displayName: u.username };

  // ---- device A: setup (K1), history, backup v1
  const A = await secondContext(browser, acct);
  const a = A.page;
  await waitForStatus(a);
  await setupViaStore(a);
  await waitForCrypto(a, (s) => !!s.status?.verified && !!s.status.backup.version, 'A verified with a backup after setup', 30_000);
  const k1Id = await defaultSecretStorageKey(u.token, u.userId);
  await openRoom(a, { roomId, spaceId });
  const texts: string[] = [];
  const ids: string[] = [];
  // Two sessions on purpose: a room-key rotation between batches (discardSession) gives A >1 Megolm session.
  for (let i = 1; i <= 4; i += 1) {
    if (i === 3) await a.evaluate((r) => (window as any).__matrixPoc.getClient().getCrypto().forceDiscardSession(r), roomId);
    const t = `[qa] before reset ${i} ${Date.now().toString(36)}`;
    texts.push(t);
    await typeAndSend(a, t);
    ids.push(await settledEventId(rowByText(a, t), 20_000));
  }
  await waitForCrypto(a, (s) => (s.backupRemaining ?? 1) === 0, 'backup v1 upload done', 60_000);
  const v1 = await keyBackup(u.token);
  expect(v1?.count ?? 0, 'backup v1 holds the room keys').toBeGreaterThanOrEqual(2);
  const sessionsOnA = await a.evaluate(async () => JSON.parse(await (window as any).__matrixPoc.security.exportRoomKeys()).length as number);
  note('state', `backup v1 ${v1!.version}: ${v1!.count} keys; A holds ${sessionsOnA} sessions`);
  lap('history + backup v1');

  // ---- JC's state: backup secret under K2 only, K2 lost; A forgets K1
  const k2Id = await a.evaluate(async () => {
    const w = (window as any).__matrixPoc;
    const client = w.getClient();
    const api = client.getCrypto();
    const generated = await api.createRecoveryKeyFromPassphrase();
    const { keyId } = await client.secretStorage.addKey('m.secret_storage.v1.aes-hmac-sha2', { key: generated.privateKey, name: 'lost key' });
    w.cryptoLifecycle.cacheSecretStorageKey(keyId, generated.privateKey);
    const backupKey: Uint8Array = await api.getSessionBackupPrivateKey();
    let bin = '';
    for (const b of backupKey) bin += String.fromCharCode(b);
    await client.secretStorage.store('m.megolm_backup.v1', btoa(bin), [keyId]);
    w.cryptoLifecycle.clearSecretStorageKeyCache(); // K1 and K2 gone from this session
    return keyId as string;
  });
  const stored = await accountData<{ encrypted?: Record<string, unknown> }>(u.token, u.userId, 'm.megolm_backup.v1');
  expect(Object.keys(stored?.encrypted ?? {})).toEqual([k2Id]);
  expect(await defaultSecretStorageKey(u.token, u.userId)).toBe(k1Id);

  // ---- the reset on A, without K1 or K2
  const tReset = Date.now();
  const reset = path === 'element' ? await resetLikeElement(a, u.password, u.userId) : await resetLikeCodec(a, u.password);
  note('reset', `prompts during reset: ${reset.prompts.join(', ') || 'none'}; ${((Date.now() - tReset) / 1000).toFixed(1)} s`);
  expect(reset.error, 'reset error').toBeNull();
  expect(reset.key, 'reset returns a new recovery key').toMatch(RECOVERY_KEY_RE);
  expect(reset.prompts, 'the reset never asked for an old recovery key').not.toContain('recovery-key');
  if (path === 'codec') await a.evaluate(() => (window as any).__matrixPoc.security.store.getState().dismissRecoveryKey());
  const newKey = reset.key!;
  const k3Id = await defaultSecretStorageKey(u.token, u.userId);
  const secretKeys: Record<string, string[]> = {};
  for (const name of ['m.cross_signing.master', 'm.cross_signing.self_signing', 'm.cross_signing.user_signing', 'm.megolm_backup.v1']) {
    secretKeys[name] = Object.keys((await accountData<{ encrypted?: Record<string, unknown> }>(u.token, u.userId, name))?.encrypted ?? {});
  }
  note('state', `after reset: default key ${k3Id}; secrets under ${JSON.stringify(secretKeys)}`);
  note('state', `A cross-signing status after reset: ${JSON.stringify(await cryptoApiCall(a, 'getCrossSigningStatus'))}`);
  expect(k3Id, 'a new default secret-storage key').not.toBe(k1Id);
  lap('reset done');

  // ---- the new backup fills up with A's existing keys
  const tDrain = Date.now();
  await expect.poll(async () => (await keyBackup(u.token))?.version, { timeout: 30_000, message: 'a new backup version' }).not.toBe(v1!.version);
  let v2 = await keyBackup(u.token);
  await expect
    .poll(async () => (v2 = await keyBackup(u.token))?.count ?? 0, { timeout: 90_000, intervals: [1000, 2000], message: 'new backup receives every room key A holds' })
    .toBeGreaterThanOrEqual(v1!.count);
  await waitForCrypto(a, (s) => (s.backupRemaining ?? 1) === 0, 'backup v2 upload done', 60_000);
  v2 = await keyBackup(u.token);
  note('state', `backup v2 ${v2!.version}: ${v2!.count} keys (v1 had ${v1!.count}); drained in ${((Date.now() - tDrain) / 1000).toFixed(1)} s`);
  expect(await cryptoApiCall<string>(a, 'getActiveSessionBackupVersion')).toBe(v2!.version);
  lap('backup v2 drained');
  await A.close();

  // ---- device B: fresh login, unlock with the NEW key, read the old history
  await loginWith(page, acct);
  await waitForStatus(page);
  await openRoom(page, { roomId, spaceId });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[B console ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  const tUnlock = Date.now();
  await unlockWith(page, newKey, { expectSuccess: false });
  await expect(page.getByTestId('recovery-done').or(page.getByTestId('recovery-error')).or(page.getByTestId('recovery-locked'))).toBeVisible({ timeout: 60_000 });
  note('B', `after unlock: ${JSON.stringify((await cryptoState(page)).recovery)}`);
  await expect(page.getByTestId('recovery-done')).toBeVisible();
  note('timing', `B unlock -> done ${((Date.now() - tUnlock) / 1000).toFixed(1)} s`);
  const restored = (await cryptoState(page)).recovery.lastRestore;
  note('state', `B restored ${restored?.imported} of ${restored?.total} keys`);
  expect(restored?.imported ?? 0).toBeGreaterThanOrEqual(v1!.count);
  await waitForCrypto(page, (s) => !!s.status?.verified, 'B verified', 30_000);
  await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
  for (const [i, id] of ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(texts[i]!, { timeout: 15_000 });
  lap('B reads all old messages');
}

// FINDING 2: resetEncryption leaves the device without its new cross-signing private keys (privateKeysCachedLocally
// all false right after it), so the new secret storage has no m.cross_signing.* and Codec's unlock with the new key
// fails at verification ("Content is not encrypted!"). The new backup does get every key. Remove fixme to re-check.
test.fixme('FINDING: Element reset identity (resetEncryption): a new Codec device cannot unlock with the new key', async ({ page, browser }) => {
  await resetScenario(page, browser, 'element');
});

// FINDING 3: bootstrapCrossSigning({ setupNewCrossSigning: true }) exports the new keys to the EXISTING secret
// storage first, which prompts for the old default key; refused -> "Recovery key entry was cancelled". Codec's
// "Reset backup" is removed from the unlock dialog; a later "Start over" must not use this order.
test.fixme('FINDING: Codec setupRecovery({ reset: true }) needs the old default key', async ({ page, browser }) => {
  await resetScenario(page, browser, 'codec');
});

/* ================================================================== 1. JC's exact path: Element "change recovery key" */

/**
 * JC's Element (2026-10-18): "key storage out of sync" -> "Enter recovery key" could not load the backup secret,
 * all three cross-signing private keys are cached -> Element offers "change recovery key" (ChangeRecoveryKeyBody):
 * `bootstrapSecretStorage({ setupNewSecretStorage: true, createSecretStorageKey })`, then, because the backup key
 * is not cached (needsBackupReset), `resetKeyBackup()` + `checkKeyBackupAndEnable()`. No resetEncryption, no
 * bootstrapCrossSigning.
 *
 * Seeding like JC: A0 creates the account (default key K2 = its setup key), sends the history (backup v1), exports
 * its room keys, moves the backup secret under a key K1 nobody keeps, logs out. A (JC's Element) logs in, unlocks
 * with K2 (verified, 3 cross-signing private keys cached; the backup prompt is cancelled -> no backup key) and
 * imports the room keys (it holds the history locally). Then A runs Element's steps; B logs in fresh and unlocks
 * with the NEW key through the Codec UI.
 */

async function secretsUnder(token: string, userId: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const name of ['m.cross_signing.master', 'm.cross_signing.self_signing', 'm.cross_signing.user_signing', 'm.megolm_backup.v1']) {
    out[name.replace('m.cross_signing.', 'cs.')] = Object.keys((await accountData<{ encrypted?: Record<string, unknown> }>(token, userId, name))?.encrypted ?? {});
  }
  return out;
}

interface JcAccount {
  u: Awaited<ReturnType<typeof freshUser>>;
  acct: Account;
  roomId: string;
  spaceId: string;
  /** The default secret-storage key (JC still has it) and its id. */
  k2: string;
  k2Id: string;
  k1Id: string;
  /** The key the backup secret was moved under (recovery-key form; "nobody keeps it" unless a test uses it). */
  k1: string;
  texts: string[];
  ids: string[];
  /** A0's room keys, `exportRoomKeysAsJson` form (what JC's Element holds locally). */
  roomKeysJson: string;
  v1: { version: string; count: number };
}

/**
 * JC's account: A0 sets up recovery (default key K2), sends 4 messages over 2 Megolm sessions (backup v1), exports
 * its room keys, moves the backup secret under a key K1 that nobody keeps, logs out.
 */
async function seedJcAccount(browser: Browser, prefix: string): Promise<JcAccount> {
  const u = await freshUser(prefix);
  const spaceId = await createRoom(u.token, { name: 'QA jc', space: true });
  const roomId = await createRoom(u.token, { name: 'secrets', encrypted: true, spaceId });
  const acct: Account = { username: u.username, password: u.password, displayName: u.username };

  // ---- A0: account owner's first device; history into backup v1
  const A0 = await secondContext(browser, acct);
  const a0 = A0.page;
  await waitForStatus(a0);
  const k2 = await setupViaStore(a0); // the default key (JC still has this one)
  await waitForCrypto(a0, (s) => !!s.status?.verified && !!s.status.backup.version, 'A0 verified with a backup', 30_000);
  const k2Id = (await defaultSecretStorageKey(u.token, u.userId))!;
  await openRoom(a0, { roomId, spaceId });
  const texts: string[] = [];
  const ids: string[] = [];
  for (let i = 1; i <= 4; i += 1) {
    if (i === 3) await a0.evaluate((r) => (window as any).__matrixPoc.getClient().getCrypto().forceDiscardSession(r), roomId);
    const t = `[qa] jc history ${i} ${Date.now().toString(36)}`;
    texts.push(t);
    await typeAndSend(a0, t);
    ids.push(await settledEventId(rowByText(a0, t), 20_000));
  }
  await waitForCrypto(a0, (s) => (s.backupRemaining ?? 1) === 0, 'backup v1 upload done', 60_000);
  const v1 = (await keyBackup(u.token))!;
  expect(v1.count).toBeGreaterThanOrEqual(2);
  const roomKeysJson = await a0.evaluate(() => (window as any).__matrixPoc.security.exportRoomKeys() as Promise<string>);
  // backup secret under K1 only; K1 is thrown away
  const k1 = await a0.evaluate(async () => {
    const w = (window as any).__matrixPoc;
    const client = w.getClient();
    const api = client.getCrypto();
    const generated = await api.createRecoveryKeyFromPassphrase();
    const { keyId } = await client.secretStorage.addKey('m.secret_storage.v1.aes-hmac-sha2', { key: generated.privateKey, name: 'old key' });
    w.cryptoLifecycle.cacheSecretStorageKey(keyId, generated.privateKey);
    const backupKey: Uint8Array = await api.getSessionBackupPrivateKey();
    let bin = '';
    for (const b of backupKey) bin += String.fromCharCode(b);
    await client.secretStorage.store('m.megolm_backup.v1', btoa(bin), [keyId]);
    return { keyId: keyId as string, encoded: generated.encodedPrivateKey as string };
  });
  const k1Id = k1.keyId;
  await A0.close();
  const before = await secretsUnder(u.token, u.userId);
  note('state', `JC state: default ${k2Id}, K1 ${k1Id}; secrets under ${JSON.stringify(before)}; backup v${v1.version} ${v1.count} keys`);
  expect(before['m.megolm_backup.v1']).toEqual([k1Id]);
  expect(before['cs.master']).toEqual([k2Id]);

  return { u, acct, roomId, spaceId, k2, k2Id, k1Id, k1: k1.encoded, texts, ids, roomKeysJson, v1 };
}

/** A device that unlocks with K2 and cannot open the backup (the backup prompt is cancelled): verified, locked. */
async function unlockK2CancelBackup(p: Page, k2: string): Promise<void> {
  const res = await p.evaluate(async (key) => {
    const store = (window as any).__matrixPoc.security.store;
    const off = store.subscribe((s: any) => {
      if (s.prompt?.kind === 'recovery-key') setTimeout(() => store.getState().answerPrompt(null), 0); // backup secret: cannot open
    });
    try {
      const ok = await store.getState().unlockWithRecoveryKey(key);
      return { ok, recovery: JSON.parse(JSON.stringify(store.getState().recovery)) };
    } finally {
      off();
    }
  }, k2);
  expect(res.ok, `unlock with K2: ${JSON.stringify(res.recovery)}`).toBe(true);
  await waitForCrypto(p, (s) => !!s.status?.verified, 'verified with K2', 30_000);
}

test('JC: Element "change recovery key" with a lost backup secret: new backup gets the old keys, a new Codec device reads the history', async ({ page, browser }) => {
  const t0 = Date.now();
  const lap = (label: string): void => note('timing', `${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const { u, acct, roomId, spaceId, k2, k2Id, texts, ids, roomKeysJson, v1 } = await seedJcAccount(browser, 'qajcchange');

  // ---- A = JC's Element: verified with K2, cross-signing keys cached, no backup key, room keys held locally
  const A = await secondContext(browser, acct);
  const a = A.page;
  await waitForStatus(a);
  await unlockK2CancelBackup(a, k2);
  await a.evaluate((j) => (window as any).__matrixPoc.security.importRoomKeys(j), roomKeysJson);
  const aState = await a.evaluate(async () => {
    const api = (window as any).__matrixPoc.getClient().getCrypto();
    return {
      cs: (await api.getCrossSigningStatus()).privateKeysCachedLocally,
      backupKeyCached: !!(await api.getSessionBackupPrivateKey()),
      sessions: JSON.parse(await (window as any).__matrixPoc.security.exportRoomKeys()).length as number,
    };
  });
  note('state', `A before change: ${JSON.stringify(aState)}`);
  expect(aState.cs).toEqual({ masterKey: true, selfSigningKey: true, userSigningKey: true });
  expect(aState.backupKeyCached, 'A has no backup key (as JC)').toBe(false);
  lap('JC state seeded');

  // ---- Element ChangeRecoveryKeyBody confirm step
  const tChange = Date.now();
  const change = await a.evaluate(async () => {
    const w = (window as any).__matrixPoc;
    const api = w.getClient().getCrypto();
    const store = w.security.store;
    const prompts: string[] = [];
    const off = store.subscribe((s: any) => {
      if (!s.prompt) return;
      prompts.push(s.prompt.kind);
      setTimeout(() => store.getState().answerPrompt(null), 0);
    });
    try {
      const recoveryKey = await api.createRecoveryKeyFromPassphrase();
      const needsBackupReset = !!(await api.getKeyBackupInfo()) && !(await api.getSessionBackupPrivateKey());
      await api.bootstrapSecretStorage({ setupNewSecretStorage: true, createSecretStorageKey: async () => recoveryKey });
      if (needsBackupReset) await api.resetKeyBackup();
      await api.checkKeyBackupAndEnable();
      await store.getState().refresh();
      return { key: recoveryKey.encodedPrivateKey as string, needsBackupReset, prompts, error: null as string | null };
    } catch (e) {
      return { key: null, needsBackupReset: null, prompts, error: e instanceof Error ? e.message : String(e) };
    } finally {
      off();
    }
  });
  note('change', `needsBackupReset ${change.needsBackupReset}; prompts ${change.prompts.join(',') || 'none'}; ${((Date.now() - tChange) / 1000).toFixed(1)} s`);
  expect(change.error).toBeNull();
  expect(change.key).toMatch(RECOVERY_KEY_RE);
  const k3Id = (await defaultSecretStorageKey(u.token, u.userId))!;
  const after = await secretsUnder(u.token, u.userId);
  note('state', `after change: default ${k3Id}; secrets under ${JSON.stringify(after)}`);
  expect(k3Id).not.toBe(k2Id);
  for (const [name, keyIds] of Object.entries(after)) expect(keyIds, `${name} under the new key`).toEqual([k3Id]);

  const tDrain = Date.now();
  await expect.poll(async () => (await keyBackup(u.token))?.version, { timeout: 30_000, message: 'a new backup version' }).not.toBe(v1.version);
  await expect
    .poll(async () => (await keyBackup(u.token))?.count ?? 0, { timeout: 120_000, intervals: [1000, 2000], message: 'new backup receives every room key A holds' })
    .toBeGreaterThanOrEqual(v1.count);
  await waitForCrypto(a, (s) => (s.backupRemaining ?? 1) === 0, 'backup v2 upload done', 60_000);
  const v2 = (await keyBackup(u.token))!;
  note('state', `backup v${v2.version}: ${v2.count} keys (old v${v1.version}: ${v1.count}); upload finished ${((Date.now() - tDrain) / 1000).toFixed(1)} s after the change`);
  lap('change done + backup drained');
  await A.close();

  // ---- B: fresh Codec login, unlock with the NEW key through the UI
  await loginWith(page, acct);
  await waitForStatus(page);
  await openRoom(page, { roomId, spaceId });
  const tUnlock = Date.now();
  await unlockWith(page, change.key!, { expectSuccess: false });
  await expect(page.getByTestId('recovery-done').or(page.getByTestId('recovery-error')).or(page.getByTestId('recovery-locked'))).toBeVisible({ timeout: 60_000 });
  note('B', `after unlock (${((Date.now() - tUnlock) / 1000).toFixed(1)} s): ${JSON.stringify((await cryptoState(page)).recovery)}`);
  await expect(page.getByTestId('recovery-done')).toBeVisible();
  await waitForCrypto(page, (s) => !!s.status?.verified, 'B verified', 30_000);
  await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
  for (const [i, id] of ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(texts[i]!, { timeout: 15_000 });
  lap('B reads the whole history');
});

/* ================================================================== 4. the way into history: an Element key file */

test('import an Element key file on a verified device whose backup is locked: history decrypts, banner goes quiet', async ({ page, browser }) => {
  const J = await seedJcAccount(browser, 'qaimport');
  const sessions = (JSON.parse(J.roomKeysJson) as unknown[]).length;
  // What Element's "Export E2E room keys" writes (small PBKDF2 round count: the format is the same).
  const file = await encryptMegolmKeyExport(J.roomKeysJson, 'export pass', { rounds: 1000 });

  // B: verified with K2, the backup secret cannot be opened -> locked, history undecryptable.
  await loginWith(page, J.acct);
  await waitForStatus(page);
  await openRoom(page, J);
  await unlockK2CancelBackup(page, J.k2);
  for (const id of J.ids) await expectUtd(page, id, /.+/, 20_000);
  const bannerEl = page.getByTestId('security-banner');
  await expect(bannerEl).toHaveAttribute('data-need', 'unavailable', { timeout: 20_000 });
  await expect(bannerEl).toContainText('Older messages are locked');

  await page.getByTestId('security-banner-action').click();
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toHaveAttribute('data-phase', /^(locked|unavailable)$/, { timeout: 10_000 });
  await dialog.getByTestId('recovery-import').click();
  await expect(dialog).toHaveAttribute('data-phase', 'import');
  const fileInput = page.getByTestId('recovery-import-file');
  const passphrase = page.getByTestId('recovery-import-passphrase');
  const submit = page.getByTestId('recovery-import-submit');
  const error = page.getByTestId('recovery-import-error');
  await expect(submit, 'nothing chosen yet').toBeDisabled();

  // Not a key file (the plain JSON export): format error, stays in import.
  await fileInput.setInputFiles({ name: 'keys.json', mimeType: 'application/json', buffer: Buffer.from(J.roomKeysJson) });
  await passphrase.fill('export pass');
  await submit.click();
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toHaveAttribute('data-phase', 'import');
  expect((await cryptoState(page)).recovery as { importError?: { kind: string } }).toMatchObject({ importError: { kind: 'format' } });

  // The real file, wrong passphrase: passphrase error, stays in import.
  await fileInput.setInputFiles({ name: 'element-keys.txt', mimeType: 'text/plain', buffer: Buffer.from(file) });
  await expect(error, 'choosing another file clears the error').toHaveCount(0);
  await passphrase.fill('wrong pass');
  await submit.click();
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toHaveAttribute('data-phase', 'import');
  expect((await cryptoState(page)).recovery as { importError?: { kind: string } }).toMatchObject({ importError: { kind: 'passphrase' } });

  // Right passphrase: done, "Imported N keys".
  await passphrase.fill('export pass');
  await expect(error).toHaveCount(0);
  await submit.click();
  const doneEl = page.getByTestId('recovery-done');
  await expect(doneEl).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toHaveAttribute('data-phase', 'done');
  expect(Number(await doneEl.getAttribute('data-imported')), 'data-imported').toBe(sessions);
  expect(Number(await doneEl.getAttribute('data-total')), 'data-total').toBe(sessions);
  await expect(doneEl).toContainText(`Imported ${sessions} keys`);
  await dialog.getByTestId('dialog-close').last().click();
  await expect(dialog).toBeHidden({ timeout: 5_000 });

  // History decrypts without a reload; the banner goes quiet.
  for (const [i, id] of J.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(J.texts[i]!, { timeout: 15_000 });
  await expect(bannerEl, 'banner quiet after the import').toHaveCount(0, { timeout: 10_000 });
});


interface EnableOutcome {
  firstCheck: { version?: string; trusted?: boolean; matches?: boolean } | null | undefined;
  reset: boolean | null;
  prompts: string[];
  error: string | null;
}

/**
 * Element's KeyStoragePanelViewModel.setEnabled(true): checkKeyBackupAndEnable; no usable backup -> resetKeyBackup +
 * checkKeyBackupAndEnable; then m.key_backup {enabled:true} and m.org.matrix.custom.backup_disabled {disabled:false}.
 * Element's 4S prompt (the user types the current key `k2`) is played by a getSecretStorageKey prompt.
 */
async function enableKeyStorageLikeElement(a: Page, k2: string): Promise<EnableOutcome> {
  return a.evaluate(async (k2) => {
    const w = (window as any).__matrixPoc;
    const client = w.getClient();
    const api = client.getCrypto();
    const store = w.security.store;
    const prompts: string[] = [];
    const off = store.subscribe((s: any) => {
      if (!s.prompt) return;
      prompts.push(`store:${s.prompt.kind}`);
      setTimeout(() => store.getState().answerPrompt(null), 0);
    });
    // Element's getSecretStorageKey asks the user, who types the current key K2. (Codec registers no
    // session-wide prompt any more, so the harness plays Element's prompt here.)
    w.cryptoLifecycle.setSecretStorageKeyPrompt(async (_info: unknown, keyId: string, ctx: { secretName?: string }) => {
      prompts.push(`4S:${keyId}:${ctx?.secretName ?? ''}`);
      return k2;
    });
    try {
      let cur = await api.checkKeyBackupAndEnable();
      const firstCheck = cur ? { version: cur.backupInfo?.version, trusted: cur.trustInfo?.trusted, matches: cur.trustInfo?.matchesDecryptionKey } : null;
      if (cur && !(cur.trustInfo.trusted || cur.trustInfo.matchesDecryptionKey)) cur = null;
      let reset = false;
      if (cur === null) {
        await api.resetKeyBackup();
        await api.checkKeyBackupAndEnable();
        reset = true;
      }
      await client.setAccountData('m.key_backup', { enabled: true });
      await client.setAccountData('m.org.matrix.custom.backup_disabled', { disabled: false });
      return { firstCheck, reset, prompts, error: null as string | null };
    } catch (e) {
      return { firstCheck: undefined, reset: null, prompts, error: e instanceof Error ? e.message : String(e) };
    } finally {
      off();
      w.cryptoLifecycle.setSecretStorageKeyPrompt(null);
    }
}, k2);
}

/* ================================================================== 5. JC after "change recovery key": delete the backup, turn key storage on */

/**
 * JC's real Element did NOT reset the backup during "change recovery key": default key = new (cross-signing under
 * it), backup secret under an old key nobody has, backup version unchanged. Proposed way out: Hubot deletes the
 * current backup version server-side; JC reloads Element and turns on Settings > Encryption > "Allow key storage"
 * (KeyStoragePanelViewModel.setEnabled(true)); then Codec unlocks with the current key.
 *
 * Variant `stale`: A also has m.key_backup {enabled:false} and a random (wrong) backup key cached for the current
 * backup version (the two candidate causes of Element skipping the backup reset).
 */
for (const variant of ['plain', 'stale'] as const) {
  test(`JC key-storage path (${variant}): delete backup, reload, enable key storage on A; B unlocks with the current key`, async ({ page, browser }) => {
    const t0 = Date.now();
    const lap = (label: string): void => note('timing', `${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const J = await seedJcAccount(browser, `qajcks${variant}`);

    // ---- A = JC's Element: verified with the current key K2, cross-signing cached, room keys held, no backup key
    const A = await secondContext(browser, J.acct);
    const a = A.page;
    await waitForStatus(a);
    await unlockK2CancelBackup(a, J.k2);
    await a.evaluate((j) => (window as any).__matrixPoc.security.importRoomKeys(j), J.roomKeysJson);
    if (variant === 'stale') {
      await a.evaluate(async (version) => {
        const client = (window as any).__matrixPoc.getClient();
        await client.setAccountData('m.key_backup', { enabled: false });
        const stale = globalThis.crypto.getRandomValues(new Uint8Array(32));
        await client.getCrypto().storeSessionBackupPrivateKey(stale, version);
      }, J.v1.version);
    }
    const aBefore = await a.evaluate(async () => {
      const client = (window as any).__matrixPoc.getClient();
      const api = client.getCrypto();
      return {
        cs: (await api.getCrossSigningStatus()).privateKeysCachedLocally,
        backupKeyCached: !!(await api.getSessionBackupPrivateKey()),
        keyBackupAccountData: client.getAccountData('m.key_backup')?.getContent() ?? null,
        sessions: JSON.parse(await (window as any).__matrixPoc.security.exportRoomKeys()).length as number,
      };
    });
    note('state', `A before: ${JSON.stringify(aBefore)}`);
    expect(aBefore.cs).toEqual({ masterKey: true, selfSigningKey: true, userSigningKey: true });
    expect(aBefore.backupKeyCached).toBe(variant === 'stale');
    lap('JC state seeded');

    // ---- 1. Hubot deletes the current backup version (separate request context, the user's token)
    await deleteKeyBackupVersion(J.u.token, J.v1.version);
    expect(await keyBackup(J.u.token), 'no backup on the server').toBeNull();

    // ---- 2. JC reloads Element
    await a.reload();
    await expect(a.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await waitForStatus(a);

    // ---- 3. KeyStoragePanelViewModel.setEnabled(true); the 4S key prompt is answered with K2 (the current key)
    const enable = await enableKeyStorageLikeElement(a, J.k2);
    note('enable', `first checkKeyBackupAndEnable after reload: ${JSON.stringify(enable.firstCheck)}; resetKeyBackup ${enable.reset}; prompts ${enable.prompts.join(', ') || 'none'}; error ${enable.error}`);
    expect(enable.error).toBeNull();
    lap('key storage enabled');

    // ---- 4. A's backup drains
    await expect.poll(async () => (await keyBackup(J.u.token))?.version ?? null, { timeout: 30_000, message: 'a new backup version' }).not.toBeNull();
    await expect
      .poll(async () => (await keyBackup(J.u.token))?.count ?? 0, { timeout: 120_000, intervals: [1000, 2000], message: 'new backup receives every room key A holds' })
      .toBeGreaterThanOrEqual(aBefore.sessions);
    await waitForCrypto(a, (s) => (s.backupRemaining ?? 1) === 0, 'A backup upload done', 60_000);
    const v2 = (await keyBackup(J.u.token))!;
    const after = await secretsUnder(J.u.token, J.u.userId);
    const defaultId = await defaultSecretStorageKey(J.u.token, J.u.userId);
    const aAfter = await a.evaluate(async () => {
      const client = (window as any).__matrixPoc.getClient();
      const api = client.getCrypto();
      const status = await api.getSecretStorageStatus();
      return {
        secretStorageReady: status.ready,
        defaultKeyId: status.defaultKeyId,
        secretStorageKeyValidityMap: status.secretStorageKeyValidityMap,
        backupKeyCached: !!(await api.getSessionBackupPrivateKey()),
        activeBackup: await api.getActiveSessionBackupVersion(),
        keyBackupAccountData: client.getAccountData('m.key_backup')?.getContent() ?? null,
      };
    });
    note('state', `after: default ${defaultId} (K2 ${J.k2Id}); secrets under ${JSON.stringify(after)}; backup v${v2.version} ${v2.count} keys (A sessions ${aBefore.sessions}, old v${J.v1.version} ${J.v1.count}); A ${JSON.stringify(aAfter)}`);
    expect(defaultId).toBe(J.k2Id);
    for (const [name, keyIds] of Object.entries(after)) expect(keyIds, `${name} under K2`).toEqual([J.k2Id]);
    expect(aAfter.secretStorageReady, 'A back in sync: secret storage ready').toBe(true);
    expect(aAfter.backupKeyCached, 'A back in sync: backup key cached').toBe(true);
    expect(aAfter.activeBackup).toBe(v2.version);
    lap('A backup drained');
    await A.close();

    // ---- 5. B: fresh Codec login, unlock with K2 in the UI
    await loginWith(page, J.acct);
    await waitForStatus(page);
    await openRoom(page, J);
    const tUnlock = Date.now();
    await unlockWith(page, J.k2, { expectSuccess: false });
    await expect(page.getByTestId('recovery-done').or(page.getByTestId('recovery-error')).or(page.getByTestId('recovery-locked'))).toBeVisible({ timeout: 60_000 });
    note('B', `after unlock (${((Date.now() - tUnlock) / 1000).toFixed(1)} s): ${JSON.stringify((await cryptoState(page)).recovery)}`);
    await expect(page.getByTestId('recovery-done')).toBeVisible();
    await waitForCrypto(page, (s) => !!s.status?.verified, 'B verified', 30_000);
    await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
    for (const [i, id] of J.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(J.texts[i]!, { timeout: 15_000 });
    lap('B reads the whole history');
  });
}

/* ================================================================== 6. JC's state: a normal unlock never asks for another key */

test("JC's state: a normal unlock with the current key never shows the prompt phase; it ends in E2 (locked, no-key)", async ({ page, browser }) => {
  const J = await seedJcAccount(browser, 'qajcnoprompt');
  await loginWith(page, J.acct);
  await waitForStatus(page);
  await openRoom(page, J);
  await expect(page.getByTestId('security-banner')).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
  await page.getByTestId('security-banner-action').click();
  await page.getByTestId('verify-use-recovery').click();
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toHaveAttribute('data-phase', 'form');
  const watch = watchRecoveryPhases(page);
  try {
    await page.getByTestId('recovery-input').fill(J.k2);
    await page.getByTestId('recovery-submit').click();
    await expect(dialog).toHaveAttribute('data-phase', 'locked', { timeout: 60_000 });
    await page.waitForTimeout(1500); // nothing follows the E2 screen either
  } finally {
    watch.stop();
  }
  note('phases', watch.phases.join(' > '));
  expect(watch.phases, 'never the prompt phase').not.toContain('prompt');
  expect(watch.prompts, 'never a recovery-key prompt').toEqual([]);
  await expect(dialog).toHaveAttribute('data-phase', 'locked');
  await expect(dialog).toContainText("Older messages can't be unlocked yet");
  await expect(page.getByTestId('recovery-locked')).toHaveAttribute('data-reason', 'no-key');
  await expect(page.getByTestId('recovery-import')).toBeVisible();
  await expect(page.getByTestId('recovery-enter-other-key')).toBeVisible();
  await expect(page.getByTestId('recovery-reset-backup')).toHaveCount(0);
  await waitForCrypto(page, (s) => !!s.status?.verified, 'verified by the current key', 30_000);
  for (const id of J.ids) await expectUtd(page, id, /.+/, 10_000);
});

/* ================================================================== 7. review O1 / O2b / O3: after an emoji verification */

/** Outgoing emoji verification from `newPage` (banner -> verify-use-device), accepted and matched on `verified`. */
async function emojiVerify(verified: Page, newPage: Page): Promise<number> {
  await expect(newPage.getByTestId('security-banner')).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
  await newPage.getByTestId('security-banner-action').click();
  await newPage.getByTestId('verify-use-device').click();
  await expect(verified.getByTestId('verify-dialog')).toHaveAttribute('data-phase', 'incoming', { timeout: 15_000 });
  await verified.getByTestId('verify-accept').click();
  await sameEmoji(verified, newPage);
  await newPage.getByTestId('verify-match').click();
  await verified.getByTestId('verify-match').click();
  await expect(newPage.getByTestId('verify-done')).toBeVisible({ timeout: 30_000 });
  const tDone = Date.now();
  await expect(verified.getByTestId('verify-done')).toBeVisible({ timeout: 30_000 });
  await closeDialog(verified, 'verify-dialog');
  return tDone;
}

test('O1 + O2b emoji match with the backup locked: Done only closes, no recovery dialog; no banner for ~10 s, then `unavailable`', async ({ page, browser }) => {
  const J = await seedJcAccount(browser, 'qao1');
  // A: verified with K2, holds no backup key (the backup secret is under K1): nothing to gossip.
  const A = await secondContext(browser, J.acct);
  await waitForStatus(A.page);
  await unlockK2CancelBackup(A.page, J.k2);

  await loginWith(page, J.acct);
  await waitForStatus(page);
  const tDone = await emojiVerify(A.page, page);
  await waitForCrypto(page, (s) => !!s.status?.verified, 'B verified by emoji', 30_000);

  // O1: one Done (dialog-close) that just closes; no "unlock" follow-up, no recovery dialog by itself.
  const vd = page.getByTestId('verify-dialog');
  await expect(vd.getByTestId('dialog-close')).toHaveCount(1);
  await expect(page.getByTestId('verify-unlock'), 'verify-unlock is gone').toHaveCount(0);
  await vd.getByTestId('dialog-close').click();
  await expect(vd).toBeHidden({ timeout: 5_000 });

  // O2b: no banner (and no recovery dialog) for ~10 s after the match on this page ...
  const bannerEl = page.getByTestId('security-banner');
  const needs: string[] = [];
  while (Date.now() - tDone < 8_500) {
    const n = await bannerEl.getAttribute('data-need', { timeout: 200 }).catch(() => null);
    if (n) needs.push(`${n}@${((Date.now() - tDone) / 1000).toFixed(1)}s`);
    expect(await page.getByTestId('recovery-dialog').count(), 'the recovery dialog never opens by itself').toBe(0);
    await page.waitForTimeout(250);
  }
  expect(needs, 'no banner in the first ~10 s after the match').toEqual([]);
  // ... then `unavailable`, because the backup key never arrived.
  await expect(bannerEl).toHaveAttribute('data-need', 'unavailable', { timeout: 25_000 });
  note('O2b', `unavailable banner ${((Date.now() - tDone) / 1000).toFixed(1)} s after verify-done`);
  await expect(bannerEl).toContainText('Older messages are locked');
  expect(await page.getByTestId('recovery-dialog').count()).toBe(0);
});

test('O3 an emoji-verified device, identity secrets under an old key, backup under the default key: the current key goes straight to done', async ({ page, browser }) => {
  // Seed: K2 = old key (identity secrets), K1 = backup secret; then K1 becomes the default ("current") key.
  const J = await seedJcAccount(browser, 'qao3');
  const A = await secondContext(browser, J.acct);
  await waitForStatus(A.page);
  await unlockK2CancelBackup(A.page, J.k2); // A: identity keys cached, no backup key
  await A.page.evaluate((id) => (window as any).__matrixPoc.getClient().secretStorage.setDefaultKeyId(id), J.k1Id);
  await expect.poll(() => defaultSecretStorageKey(J.u.token, J.u.userId), { timeout: 10_000 }).toBe(J.k1Id);
  const under = await secretsUnder(J.u.token, J.u.userId);
  note('state', `default ${J.k1Id}; secrets under ${JSON.stringify(under)}`);
  expect(under['cs.master'], 'identity secrets only under the old key').toEqual([J.k2Id]);
  expect(under['m.megolm_backup.v1'], 'backup secret under the default key').toEqual([J.k1Id]);

  // B: emoji-verified by A (A has no backup key to hand over).
  await loginWith(page, J.acct);
  await waitForStatus(page);
  await openRoom(page, J);
  await emojiVerify(A.page, page);
  await waitForCrypto(page, (s) => !!s.status?.verified, 'B verified by emoji', 30_000);
  await page.getByTestId('verify-dialog').getByTestId('dialog-close').click();
  expect(await cryptoApiCall(page, 'getSessionBackupPrivateKey'), 'no backup key gossiped').toBeNull();

  // The current key, through the form: straight to done (no "can't verify this device", no prompt).
  await openSecurityDialog(page, 'unlock');
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toHaveAttribute('data-phase', 'form', { timeout: 10_000 });
  const watch = watchRecoveryPhases(page);
  try {
    await page.getByTestId('recovery-input').fill(J.k1);
    await page.getByTestId('recovery-submit').click();
    await expect(page.getByTestId('recovery-done').or(page.getByTestId('recovery-error')).or(page.getByTestId('recovery-locked'))).toBeVisible({ timeout: 60_000 });
  } finally {
    watch.stop();
  }
  note('phases', watch.phases.join(' > '));
  note('B', JSON.stringify((await cryptoState(page)).recovery));
  await expect(page.getByTestId('recovery-error'), "no \"can't verify this device\"").toHaveCount(0);
  await expect(page.getByTestId('recovery-verify-device')).toHaveCount(0);
  await expect(page.getByTestId('recovery-done')).toBeVisible();
  await expect(page.getByTestId('recovery-done')).toContainText(/Restored \d+ of \d+ keys/);
  expect(watch.phases).not.toContain('prompt');
  expect(watch.prompts).toEqual([]);
  await dialog.getByTestId('dialog-close').last().click();
  for (const [i, id] of J.ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(J.texts[i]!, { timeout: 15_000 });
});

/* ================================================================== 5b. JC key-storage path, sessions already backed up */

/**
 * Like 5, but A's sessions are already marked "backed up" to the current version (as on JC's Element, where every
 * session was uploaded to v4): A sends its own messages and imports A0's keys while its backup uploads to v1 (with
 * the public key only: A never holds the backup decryption key). After v1 is deleted and A reloads, the active
 * version is null, so the SDK enables the new version without `disableKeyBackup()`: does Rust re-upload sessions
 * already marked for the deleted version? Fallback if short: `resetKeyBackup()` again while the new one is active.
 */
test('JC key-storage path (already backed up): the toggle, then a second resetKeyBackup if short, gets every session into the new backup; B reads all', async ({ page, browser }) => {
  const t0 = Date.now();
  const lap = (label: string): void => note('timing', `${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const J = await seedJcAccount(browser, 'qajcbacked');

  const A = await secondContext(browser, J.acct);
  const a = A.page;
  await waitForStatus(a);
  await unlockK2CancelBackup(a, J.k2); // verified, identity keys cached, no backup decryption key
  const counts = (): Promise<{ total: number; backedUp: number; active: string | null; keyCached: boolean }> =>
    a.evaluate(async () => {
      const api = (window as any).__matrixPoc.getClient().getCrypto();
      const c = await api.olmMachine.roomKeyCounts();
      return { total: Number(c.total), backedUp: Number(c.backedUp), active: (await api.getActiveSessionBackupVersion()) ?? null, keyCached: !!(await api.getSessionBackupPrivateKey()) };
    });
  // Element enables the (trusted) server backup at startup; uploading needs only its public key.
  await a.evaluate(() => (window as any).__matrixPoc.getClient().getCrypto().checkKeyBackupAndEnable());
  await expect.poll(async () => (await counts()).active, { timeout: 20_000, message: 'A backs up to v1' }).toBe(J.v1.version);

  // A's own history (2 Megolm sessions) + A0's keys held locally, all uploaded to v1.
  await openRoom(a, J);
  const texts = [...J.texts];
  const ids = [...J.ids];
  for (let i = 1; i <= 4; i += 1) {
    if (i === 3) await a.evaluate((r) => (window as any).__matrixPoc.getClient().getCrypto().forceDiscardSession(r), J.roomId);
    const t = `[qa] A's own ${i} ${Date.now().toString(36)}`;
    texts.push(t);
    await typeAndSend(a, t);
    ids.push(await settledEventId(rowByText(a, t), 20_000));
  }
  await a.evaluate((j) => (window as any).__matrixPoc.security.importRoomKeys(j), J.roomKeysJson);
  await expect
    .poll(async () => {
      const c = await counts();
      return c.total > 0 && c.backedUp === c.total;
    }, { timeout: 60_000, intervals: [1000, 2000], message: 'every session on A marked backed up to v1' })
    .toBe(true);
  const before = await counts();
  const v1Server = (await keyBackup(J.u.token))!;
  note('state', `before delete: A active ${before.active} (current ${J.v1.version}), roomKeyCounts ${before.backedUp}/${before.total} backed up, backup key cached ${before.keyCached}; server v${v1Server.version} ${v1Server.count} keys`);
  expect(before.active).toBe(J.v1.version);
  expect(before.backedUp).toBe(before.total);
  expect(before.keyCached, 'A has no backup decryption key (as JC)').toBe(false);
  lap('A fully backed up to v1');

  // Hubot deletes v1; JC reloads Element and turns key storage on (types K2 at the prompt).
  await deleteKeyBackupVersion(J.u.token, J.v1.version);
  expect(await keyBackup(J.u.token)).toBeNull();
  await a.reload();
  await expect(a.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await waitForStatus(a);
  note('state', `after reload: ${JSON.stringify(await counts())}`);
  const enable = await enableKeyStorageLikeElement(a, J.k2);
  note('enable', `first check ${JSON.stringify(enable.firstCheck)}; resetKeyBackup ${enable.reset}; prompts ${enable.prompts.join(', ') || 'none'}; error ${enable.error}`);
  expect(enable.error).toBeNull();
  const tToggle = Date.now();
  await expect.poll(async () => (await keyBackup(J.u.token))?.version ?? null, { timeout: 30_000 }).not.toBeNull();
  const v2 = (await keyBackup(J.u.token))!.version;
  // Give the upload loop its chance (it starts within ~10 s): full count, or settle without growth.
  let v2Count = 0;
  await expect
    .poll(async () => (v2Count = (await keyBackup(J.u.token))?.count ?? 0), { timeout: 45_000, intervals: [1000, 2000] })
    .toBeGreaterThanOrEqual(before.total)
    .catch(() => undefined);
  const afterToggle = await counts();
  note('state', `new backup v${v2}: ${v2Count} keys on the server vs A total ${before.total} (${((Date.now() - tToggle) / 1000).toFixed(1)} s after the toggle); A roomKeyCounts ${afterToggle.backedUp}/${afterToggle.total}, active ${afterToggle.active}`);
  // FINDING (observed 2026-10-18: v2 0 of 4 after 43 s, roomKeyCounts stayed 4/4 "backed up"): the toggle alone does
  // not re-upload sessions marked backed up to the deleted version; recorded, not asserted (an SDK fix would turn it green).
  if (v2Count < before.total) note('FINDING', `toggle alone: new backup v${v2} got ${v2Count} of ${before.total} sessions; the fallback reset is needed`);
  lap('toggle + wait');

  if (v2Count < before.total) {
    // Fallback: switch versions while one is active (disableKeyBackup -> every session marked not backed up).
    const again = await a.evaluate(async (k2) => {
      const w = (window as any).__matrixPoc;
      const api = w.getClient().getCrypto();
      w.cryptoLifecycle.setSecretStorageKeyPrompt(async () => k2);
      try {
        await api.resetKeyBackup();
        await api.checkKeyBackupAndEnable();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        w.cryptoLifecycle.setSecretStorageKeyPrompt(null);
      }
    }, J.k2);
    expect(again, 'fallback resetKeyBackup').toBeNull();
    await expect.poll(async () => (await keyBackup(J.u.token))?.version, { timeout: 30_000 }).not.toBe(v2);
    let v3Count = 0;
    await expect
      .poll(async () => (v3Count = (await keyBackup(J.u.token))?.count ?? 0), { timeout: 60_000, intervals: [1000, 2000] })
      .toBeGreaterThanOrEqual(before.total)
      .catch(() => undefined);
    const v3 = (await keyBackup(J.u.token))!.version;
    note('fallback', `resetKeyBackup again -> v${v3}: ${v3Count} keys vs A total ${before.total}; A roomKeyCounts ${JSON.stringify(await counts())}`);
  }
  await waitForCrypto(a, (s) => (s.backupRemaining ?? 1) === 0, 'A backup upload done', 60_000).catch(() => undefined);
  const final = (await keyBackup(J.u.token))!;
  const under = await secretsUnder(J.u.token, J.u.userId);
  note('state', `final backup v${final.version}: ${final.count} keys; secrets under ${JSON.stringify(under)}`);
  expect(final.count, 'the final backup holds every session A has').toBeGreaterThanOrEqual(before.total);
  for (const [name, keyIds] of Object.entries(under)) expect(keyIds, `${name} under K2`).toEqual([J.k2Id]);
  await A.close();

  // B: fresh Codec login, unlock with K2, read A0's and A's history.
  await loginWith(page, J.acct);
  await waitForStatus(page);
  await openRoom(page, J);
  await unlockWith(page, J.k2, { expectSuccess: false });
  await expect(page.getByTestId('recovery-done').or(page.getByTestId('recovery-error')).or(page.getByTestId('recovery-locked'))).toBeVisible({ timeout: 60_000 });
  note('B', JSON.stringify((await cryptoState(page)).recovery));
  await expect(page.getByTestId('recovery-done')).toBeVisible();
  await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
  for (const [i, id] of ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(texts[i]!, { timeout: 15_000 });
  lap('B reads the whole history');
});

/* ================================================================== 8. JC fixes it on W, the device that created the backup */

/**
 * JC's account as Hubot found it: Element Desktop W created the current backup (its key cached on W) while K1 was
 * the default key, so `m.megolm_backup.v1` sits under K1. Another Element device D later changed the recovery key
 * to K2 WITHOUT a backup reset (ChangeRecoveryKey: `bootstrapSecretStorage({ setupNewSecretStorage, createSecretStorageKey })`;
 * D held the 3 cross-signing keys but no backup key): default K2, cross-signing under K2, backup under K1 only.
 * W is still signed in. On W, Element's RecoveryPanelOutOfSync "Enter recovery key" (JC types K2 at every prompt):
 *  1. needsBackupReset = shouldHaveBackup && !backupKeyCached && !backupKeyStored (DeviceListener, forgotRecovery false)
 *  2. accessSecretStorage: bootstrapCrossSigning({ authUploadDeviceSigningKeys }), then bootstrapSecretStorage({})
 *  3. needsBackupReset ? resetKeyBackup() : isKeyBackupKeyStored() ? loadSessionBackupPrivateKeyFromSecretStorage()
 * Then B (fresh Codec) unlocks with K2, and C (a Codec device verified with K2 before the fix, in E2) reloads and
 * restores with K2. Variant `mismatch`: W's cached backup key does not match the current backup.
 */
for (const variant of ['match', 'mismatch'] as const) {
  test(`JC fixes it on W (Element "Enter recovery key", backup key ${variant === 'match' ? 'cached' : 'cached but stale'}): no reset, no delete${variant === 'match' ? '; B and a reloaded C restore with K2' : ''}`, async ({ page, browser }) => {
    test.setTimeout(480_000);
    const t0 = Date.now();
    const lap = (label: string): void => note('timing', `${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const u = await freshUser(`qajcw${variant}`);
    const spaceId = await createRoom(u.token, { name: 'QA jc', space: true });
    const roomId = await createRoom(u.token, { name: 'secrets', encrypted: true, spaceId });
    const J = { roomId, spaceId };
    const acct: Account = { username: u.username, password: u.password, displayName: u.username };

    // ---- W: sets up recovery with K1 (cross-signing, backup v1, backup key cached), sends the history
    const W = await secondContext(browser, acct);
    const w = W.page;
    await waitForStatus(w);
    const k1 = await setupViaStore(w);
    await waitForCrypto(w, (s) => !!s.status?.verified && !!s.status.backup.version, 'W verified with a backup', 30_000);
    const k1Id = (await defaultSecretStorageKey(u.token, u.userId))!;
    await openRoom(w, J);
    const texts: string[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      if (i === 3) await w.evaluate((r) => (window as any).__matrixPoc.getClient().getCrypto().forceDiscardSession(r), roomId);
      const t = `[qa] W history ${i} ${Date.now().toString(36)}`;
      texts.push(t);
      await typeAndSend(w, t);
      ids.push(await settledEventId(rowByText(w, t), 20_000));
    }
    await expect
      .poll(async () => (await keyBackup(u.token))?.count ?? 0, { timeout: 60_000, intervals: [500, 1000], message: "both of W's sessions in backup v1" })
      .toBeGreaterThanOrEqual(2);
    const v1 = (await keyBackup(u.token))!;
    for (const [name, keyIds] of Object.entries(await secretsUnder(u.token, u.userId))) expect(keyIds, `${name} under K1`).toEqual([k1Id]);
    lap('W set up, history in v1');

    // ---- D: another Element device; takes the cross-signing keys from 4S (types K1 for those only), no backup key,
    // then ChangeRecoveryKey without a backup reset.
    const D = await secondContext(browser, acct);
    const d = D.page;
    await waitForStatus(d);
    const change = await d.evaluate(
      async ([k1, pw, user]) => {
        const win = window as any;
        const lc = win.__matrixPoc.cryptoLifecycle;
        const client = win.__matrixPoc.getClient();
        const api = client.getCrypto();
        const prompts: string[] = [];
        lc.setSecretStorageKeyPrompt(async (_info: unknown, keyId: string, ctx: { secretName?: string }) => {
          prompts.push(`4S:${keyId}:${ctx?.secretName ?? ''}`);
          return ctx?.secretName?.startsWith('m.cross_signing.') ? k1 : null;
        });
        const uia = async (makeRequest: (auth: unknown) => Promise<unknown>): Promise<void> => {
          try {
            await makeRequest(null);
          } catch (e: any) {
            const session = e?.data?.session;
            if (!session) throw e;
            await makeRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: pw, session });
          }
        };
        try {
          await api.bootstrapCrossSigning({ authUploadDeviceSigningKeys: uia });
          lc.clearSecretStorageKeyCache();
          const cs = (await api.getCrossSigningStatus()).privateKeysCachedLocally;
          const backupKeyCached = !!(await api.getSessionBackupPrivateKey());
          const recoveryKey = await api.createRecoveryKeyFromPassphrase();
          const needsBackupReset = !!(await api.getKeyBackupInfo()) && !backupKeyCached; // Element: here it is reset; the account did not
          await api.bootstrapSecretStorage({ setupNewSecretStorage: true, createSecretStorageKey: async () => recoveryKey });
          return { k2: recoveryKey.encodedPrivateKey as string, cs, backupKeyCached, needsBackupReset, prompts, error: null as string | null };
        } catch (e) {
          return { k2: null, cs: null, backupKeyCached: null, needsBackupReset: null, prompts, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        } finally {
          lc.setSecretStorageKeyPrompt(null);
          lc.clearSecretStorageKeyCache();
        }
      },
      [k1, acct.password, u.userId] as const,
    );
    note('D', `change recovery key without backup reset: ${JSON.stringify({ ...change, k2: change.k2 ? 'EsT…' : null })}`);
    expect(change.error).toBeNull();
    expect(change.cs).toEqual({ masterKey: true, selfSigningKey: true, userSigningKey: true });
    expect(change.backupKeyCached, 'D has no backup key').toBe(false);
    const k2 = change.k2!;
    const k2Id = (await defaultSecretStorageKey(u.token, u.userId))!;
    expect(k2Id).not.toBe(k1Id);
    const jcState = await secretsUnder(u.token, u.userId);
    note('state', `JC state: default K2 ${k2Id}, K1 ${k1Id}; secrets under ${JSON.stringify(jcState)}; backup v${v1.version} ${v1.count} keys`);
    expect(jcState['m.megolm_backup.v1'], 'backup secret under K1 only').toEqual([k1Id]);
    for (const n of ['cs.master', 'cs.self_signing', 'cs.user_signing']) expect(jcState[n], `${n} under K2 only`).toEqual([k2Id]);
    const afterChange = (await keyBackup(u.token))!;
    expect(afterChange.version, 'the key change left the backup alone').toBe(v1.version);
    expect(afterChange.count).toBeGreaterThanOrEqual(v1.count);
    await D.close();
    lap('D changed the key (JC state)');

    // ---- C: JC's Codec device, verified with K2 before the fix: E2 (locked, no-key)
    let C: Awaited<ReturnType<typeof secondContext>> | null = null;
    if (variant === 'match') {
      C = await secondContext(browser, acct);
      // Banner transitions with page-relative times (for the reload after the fix).
      await C.page.addInitScript(() => {
        const w = window as any;
        w.__qaBanner = [] as string[];
        let last: string | null = null;
        const tick = (): void => {
          const need = document.querySelector('[data-testid="security-banner"]')?.getAttribute('data-need') ?? 'none';
          if (need !== last) {
            last = need;
            w.__qaBanner.push(`${need}@${Math.round(performance.now())}ms`);
          }
        };
        new MutationObserver(tick).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-need'] });
      });
      await waitForStatus(C.page);
      await openRoom(C.page, J);
      await unlockWith(C.page, k2, { expectPhase: 'locked' });
      await expect(C.page.getByTestId('recovery-locked')).toHaveAttribute('data-reason', 'no-key');
      await waitForCrypto(C.page, (s) => !!s.status?.verified, 'C verified with K2', 30_000);
      await C.page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
      lap('C verified with K2, backup locked');
    }

    // ---- W as JC's Element: the 4S key is not kept between operations; it has seen the new default key
    await w.evaluate(() => (window as any).__matrixPoc.cryptoLifecycle.clearSecretStorageKeyCache());
    await expect
      .poll(() => w.evaluate(() => (window as any).__matrixPoc.getClient().getAccountData('m.secret_storage.default_key')?.getContent()?.key ?? null), {
        timeout: 20_000,
        message: 'W synced the new default key',
      })
      .toBe(k2Id);
    if (variant === 'mismatch') {
      await w.evaluate(async (version) => {
        const stale = globalThis.crypto.getRandomValues(new Uint8Array(32));
        await (window as any).__matrixPoc.getClient().getCrypto().storeSessionBackupPrivateKey(stale, version);
      }, v1.version);
    }
    const wState = (): Promise<{ backupKeyCached: boolean; matches: boolean | null; active: string | null; cs: unknown }> =>
      w.evaluate(async () => {
        const api = (window as any).__matrixPoc.getClient().getCrypto();
        const info = await api.getKeyBackupInfo();
        return {
          backupKeyCached: !!(await api.getSessionBackupPrivateKey()),
          matches: info ? (await api.isKeyBackupTrusted(info)).matchesDecryptionKey : null,
          active: (await api.getActiveSessionBackupVersion()) ?? null,
          cs: (await api.getCrossSigningStatus()).privateKeysCachedLocally,
        };
      });
    const wBefore = await wState();
    note('W', `before: ${JSON.stringify(wBefore)}`);
    expect(wBefore.backupKeyCached).toBe(true);
    expect(wBefore.matches).toBe(variant === 'match');

    // Other devices keep adding sessions to v1 (C opens the room): compare with the count right before the fix.
    const backupBefore = (await keyBackup(u.token))!;
    note('state', `backup right before the fix: v${backupBefore.version} ${backupBefore.count} keys (after W's history: ${v1.count})`);

    // ---- RecoveryPanelOutOfSync "Enter recovery key" on W
    const fix = await w.evaluate(
      async ([k2, pw, user]) => {
        const win = window as any;
        const lc = win.__matrixPoc.cryptoLifecycle;
        const client = win.__matrixPoc.getClient();
        const api = client.getCrypto();
        const store = win.__matrixPoc.security.store;
        const prompts: string[] = [];
        const steps: string[] = [];
        const off = store.subscribe((s: any) => {
          if (!s.prompt) return;
          prompts.push(`store:${s.prompt.kind}`);
          setTimeout(() => store.getState().answerPrompt(null), 0);
        });
        // Element's AccessSecretStorageDialog: JC types K2 whatever key it asks for.
        lc.setSecretStorageKeyPrompt(async (_info: unknown, keyId: string, ctx: { secretName?: string }) => {
          prompts.push(`4S:${keyId}:${ctx?.secretName ?? ''}`);
          return k2;
        });
        const uia = async (makeRequest: (auth: unknown) => Promise<unknown>): Promise<void> => {
          steps.push('uia');
          try {
            await makeRequest(null);
          } catch (e: any) {
            const session = e?.data?.session;
            if (!session) throw e;
            await makeRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: pw, session });
          }
        };
        let needs: Record<string, boolean> | null = null;
        try {
          // 1. DeviceListener.keyStorageOutOfSyncNeedsBackupReset(false)
          const shouldHaveBackup = !(await client.getAccountDataFromServer('m.org.matrix.custom.backup_disabled'))?.disabled;
          const backupKeyCached = (await api.getSessionBackupPrivateKey()) !== null;
          const backupKeyStored = !!(await client.isKeyBackupKeyStored());
          needs = { shouldHaveBackup, backupKeyCached, backupKeyStored, needsBackupReset: shouldHaveBackup && !backupKeyCached && !backupKeyStored };
          // 2. accessSecretStorage (4S key exists: no new one)
          await api.bootstrapCrossSigning({ authUploadDeviceSigningKeys: uia });
          steps.push('bootstrapCrossSigning');
          await api.bootstrapSecretStorage({});
          steps.push('bootstrapSecretStorage');
          // 3. the panel's callback
          if (needs.needsBackupReset) {
            await api.resetKeyBackup();
            steps.push('resetKeyBackup');
          } else if (await client.isKeyBackupKeyStored()) {
            await api.loadSessionBackupPrivateKeyFromSecretStorage();
            steps.push('loadSessionBackupPrivateKeyFromSecretStorage');
          }
          return { needs, steps, prompts, error: null as string | null };
        } catch (e) {
          return { needs, steps, prompts, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        } finally {
          off();
          lc.setSecretStorageKeyPrompt(null);
          lc.clearSecretStorageKeyCache(); // accessSecretStorage forgets the key afterwards
        }
      },
      [k2, acct.password, u.userId] as const,
    );
    note('W', `Enter recovery key: ${JSON.stringify(fix)}`);
    expect(fix.needs?.needsBackupReset, 'a cached backup key: no backup reset').toBe(false);
    expect(fix.steps, 'never a backup reset').not.toContain('resetKeyBackup');
    await w.waitForTimeout(3000); // anything W would do next (backup loop, restore on key cached) gets its chance
    const wAfter = await wState();
    const afterFix = await secretsUnder(u.token, u.userId);
    const backupAfter = await keyBackup(u.token);
    note('state', `after the fix: default ${await defaultSecretStorageKey(u.token, u.userId)}; secrets under ${JSON.stringify(afterFix)}; backup ${JSON.stringify(backupAfter && { version: backupAfter.version, count: backupAfter.count })} (before the fix v${backupBefore.version} ${backupBefore.count}); W ${JSON.stringify(wAfter)}`);
    expect(backupAfter, 'the backup is never deleted').not.toBeNull();
    expect(backupAfter!.version, 'same backup version (no reset, no delete)').toBe(v1.version);
    expect(backupAfter!.count, 'no key lost from the backup').toBeGreaterThanOrEqual(backupBefore.count);
    for (const n of ['cs.master', 'cs.self_signing', 'cs.user_signing']) expect(afterFix[n], `${n} under K2 only`).toEqual([k2Id]);
    lap('W ran "Enter recovery key"');

    if (variant === 'mismatch') {
      // W cannot store a key that does not match: the backup secret stays under K1, and step 3 asks for K1.
      expect(fix.error, 'step 3 fails: the backup secret is only under K1').not.toBeNull();
      expect(afterFix['m.megolm_backup.v1'], 'backup secret still under K1 only').toEqual([k1Id]);
      expect(wAfter.matches).toBe(false);
      await W.close();
      return;
    }

    expect(fix.error).toBeNull();
    expect(fix.steps).toEqual(['bootstrapCrossSigning', 'bootstrapSecretStorage', 'loadSessionBackupPrivateKeyFromSecretStorage']);
    expect(afterFix['m.megolm_backup.v1'], 'backup secret under K2 only').toEqual([k2Id]);
    expect(wAfter).toMatchObject({ backupKeyCached: true, matches: true, active: v1.version });
    await W.close();

    // ---- B: fresh Codec device, unlock with K2 through the UI
    await loginWith(page, acct);
    await waitForStatus(page);
    await openRoom(page, J);
    await unlockWith(page, k2, { expectSuccess: false });
    await expect(page.getByTestId('recovery-done').or(page.getByTestId('recovery-error')).or(page.getByTestId('recovery-locked'))).toBeVisible({ timeout: 60_000 });
    note('B', JSON.stringify((await cryptoState(page)).recovery));
    await expect(page.getByTestId('recovery-done')).toBeVisible();
    await expect(page.getByTestId('recovery-done')).toContainText(/Restored \d+ of \d+ keys/);
    await waitForCrypto(page, (s) => !!s.status?.verified, 'B verified', 30_000);
    await page.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
    for (const [i, id] of ids.entries()) await expect(row(page, id).getByTestId('message-body')).toHaveText(texts[i]!, { timeout: 15_000 });
    lap('B reads the whole history');

    // ---- C: verified with K2 before the fix (E2 this page load); reloads, then restores with K2
    const c = C!.page;
    note('C', `before reload: banner ${await c.getByTestId('security-banner').getAttribute('data-need', { timeout: 1000 }).catch(() => null)}`);
    await c.reload();
    await expect(c.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await waitForStatus(c);
    const banner = c.getByTestId('security-banner');
    await expect(banner, 'the backup is under the current key: a plain unlock, not E2').toHaveAttribute('data-need', 'unlock', { timeout: 30_000 });
    note('C', `after reload: banner transitions ${JSON.stringify(await c.evaluate(() => (window as any).__qaBanner))}`);
    await unlockWith(c, k2, { expectSuccess: false });
    await expect(c.getByTestId('recovery-done').or(c.getByTestId('recovery-error')).or(c.getByTestId('recovery-locked'))).toBeVisible({ timeout: 60_000 });
    note('C', JSON.stringify((await cryptoState(c)).recovery));
    await expect(c.getByTestId('recovery-done')).toBeVisible();
    await c.getByTestId('recovery-dialog').getByTestId('dialog-close').last().click();
    await openRoom(c, J);
    for (const [i, id] of ids.entries()) await expect(row(c, id).getByTestId('message-body')).toHaveText(texts[i]!, { timeout: 15_000 });
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
    lap('C reloaded and reads the whole history');
    await C!.close();
  });
}
