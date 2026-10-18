import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import viteConfig from '../vite.config.ts';
import { firstWriteAfter, freshVerdictFile, loadOrProbe, newestMainTimelineEvent, type FreshSeedReport } from './fixtures/fresh.ts';
import type { MatrixEventJson } from './fixtures/matrix-api.ts';
import { fileActiveAt, filesInLog } from './fixtures/run-log.ts';

/**
 * Regression tests for the e2e harness itself (issue #2, docs/BUGS.md BUG-23..25). No browser, no homeserver.
 */

const ev = (event_id: string, content: Record<string, unknown> = { msgtype: 'm.text', body: event_id }): MatrixEventJson => ({
  event_id,
  type: 'm.room.message',
  sender: '@carol:localhost',
  origin_server_ts: 0,
  content,
});

test.describe('fresh-seed guard', () => {
  test('BUG-23 the seed\'s late thread reply after general.last does not make a pristine seed read as dirty', () => {
    // Shape of the seed's #general tail (seed/seed.ts: general.last, then carol's `late: true` thread reply).
    const chunk = [
      ev('$late-thread-reply', {
        msgtype: 'm.text',
        body: 'Tacos were great. Same place next week?',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root', is_falling_back: true, 'm.in_reply_to': { event_id: '$root' } },
      }),
      ev('$general.last'),
      ev('$older'),
    ];
    expect(newestMainTimelineEvent(chunk)?.event_id).toBe('$general.last');
  });

  test('BUG-23 a main-timeline message or plain reply after general.last still reads as dirty', () => {
    const reply = ev('$reply', { msgtype: 'm.text', body: 'Yes', 'm.relates_to': { 'm.in_reply_to': { event_id: '$x' } } });
    expect(newestMainTimelineEvent([reply, ev('$general.last')])?.event_id).toBe('$reply');
    expect(newestMainTimelineEvent([ev('$new'), ev('$general.last')])?.event_id).toBe('$new');
  });

  test('BUG-24 a restarted worker reuses the persisted verdict instead of re-probing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fresh-verdict-'));
    try {
      const file = path.join(dir, 'fresh-w0.json');
      const pristine: FreshSeedReport = { fresh: true, reasons: [] };
      const dirty: FreshSeedReport = { fresh: false, reasons: ['#general has events after the seeded last message'] };
      let probes = 0;

      // First worker process: no verdict yet -> probes the pristine server and persists the result.
      expect(await loadOrProbe(file, async () => (probes++, pristine))).toEqual(pristine);
      expect(probes).toBe(1);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(pristine);

      // Restarted worker on the same (now dirtied) server: reuses the persisted verdict, never probes.
      expect(await loadOrProbe(file, async () => (probes++, dirty))).toEqual(pristine);
      expect(probes).toBe(1);

      // No restore (E2E_REUSE_SERVERS, reused :8008, WSL1): nothing is persisted, every process probes.
      rmSync(file);
      expect(await loadOrProbe(undefined, async () => (probes++, dirty))).toEqual(dirty);
      expect(probes).toBe(2);
      expect(existsSync(file)).toBe(false);

      // A torn file is ignored and replaced.
      writeFileSync(file, '{"fresh":');
      expect(await loadOrProbe(file, async () => (probes++, pristine))).toEqual(pristine);
      expect(probes).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BUG-24 verdicts are kept per (pool instance, spec file): a later file on a dirtied server probes for itself', async () => {
    const smoke = freshVerdictFile(0, '/repo/e2e/smoke.spec.ts');
    expect(path.basename(smoke)).toBe('fresh-w0-smoke.spec.ts.json');
    expect(path.dirname(smoke)).toBe(path.resolve('e2e/tmp'));
    expect(freshVerdictFile(0, '/repo/e2e/navigation.spec.ts')).not.toBe(smoke);
    expect(freshVerdictFile(1, '/repo/e2e/smoke.spec.ts')).not.toBe(smoke);

    const dir = mkdtempSync(path.join(os.tmpdir(), 'fresh-verdict-'));
    try {
      const first = path.join(dir, path.basename(freshVerdictFile(0, '/repo/e2e/navigation.spec.ts')));
      const later = path.join(dir, path.basename(smoke));
      const pristine: FreshSeedReport = { fresh: true, reasons: [] };
      const dirty: FreshSeedReport = { fresh: false, reasons: ['#general has events after the seeded last message'] };
      // The first file on the instance judged a pristine server...
      expect(await loadOrProbe(first, async () => pristine)).toEqual(pristine);
      // ...a file that runs after it does not inherit that verdict: it probes the (now dirty) server and skips honestly.
      let probes = 0;
      expect(await loadOrProbe(later, async () => (probes++, dirty))).toEqual(dirty);
      expect(probes).toBe(1);
      // A worker restarted mid-file reuses that file's own verdict.
      expect(await loadOrProbe(later, async () => (probes++, pristine))).toEqual(dirty);
      expect(probes).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PERF-3 a fresh-seed skip names the spec file that dirtied the server', () => {
    const log = [
      { file: 'auth-media.spec.ts', t: 1_000 },
      { file: 'conversation-messages.spec.ts', t: 2_000 },
      { file: 'navigation.spec.ts', t: 5_000 },
    ];
    expect(fileActiveAt(log, 500)).toBeUndefined();
    expect(fileActiveAt(log, 2_500)).toBe('conversation-messages.spec.ts');
    expect(fileActiveAt(log, 9_000)).toBe('navigation.spec.ts');
    expect(filesInLog([...log, { file: 'navigation.spec.ts', t: 6_000 }])).toEqual([
      'auth-media.spec.ts',
      'conversation-messages.spec.ts',
      'navigation.spec.ts',
    ]);

    const at = (id: string, ts: number, sender = '@alice:localhost', body = id): MatrixEventJson => ({
      ...ev(id, { msgtype: 'm.text', body }),
      origin_server_ts: ts,
      sender,
    });
    // /messages?dir=b: newest first. Two test posts after the seeded last message; the older one is the first write.
    const chunk = [
      at('$second', 3_000),
      ev('$thread-reply', { msgtype: 'm.text', body: 'x', 'm.relates_to': { rel_type: 'm.thread', event_id: '$r' } }),
      at('$first', 2_400, '@bob:localhost', '[qa] AC-B2-1 hello'),
      at('$general.last', 100),
    ];
    const reason = firstWriteAfter(chunk, '$general.last', log);
    expect(reason).toContain('@bob:localhost');
    expect(reason).toContain('"[qa] AC-B2-1 hello"');
    expect(reason).toContain('while conversation-messages.spec.ts was using this server');
    expect(firstWriteAfter([at('$x', 2_400)], '$general.last', log)).toContain('(at least 50 events ago)');
    expect(firstWriteAfter([at('$x', 10)], '$general.last', [])).toContain('while no logged spec file was using this server');
  });
});

test.describe('dev server config', () => {
  test('BUG-25 the Vite watcher ignores Playwright output (e2e/results, playwright-report) but still watches src/', () => {
    const ignored = viteConfig.server?.watch?.ignored;
    const patterns = (Array.isArray(ignored) ? ignored : [ignored]).filter((p): p is string => typeof p === 'string');
    expect(patterns).toEqual(expect.arrayContaining(['**/e2e/results/**', '**/playwright-report/**']));
    // Vite/chokidar match with dot files on (traces live under e2e/results/*/.playwright-artifacts-N/); Node's
    // matchesGlob does not, so the paths checked here avoid dot segments and the line above pins the patterns.
    const isIgnored = (file: string) => patterns.some((pattern) => path.matchesGlob(file, pattern));
    const root = path.resolve('/repo');
    for (const p of [
      'e2e/results/desktop/some-test/trace.zip',
      'e2e/results/mobile/some-test/video.webm',
      'playwright-report/index.html',
      'playwright-report/data/abc.zip',
    ]) {
      expect(isIgnored(path.join(root, p)), `${p} must not be watched`).toBe(true);
    }
    expect(isIgnored(path.join(root, 'src/main.tsx')), 'src/ must still be watched').toBe(false);
  });
});
