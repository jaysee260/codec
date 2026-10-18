/**
 * Unit tests for scripts/select-e2e.mjs (which e2e specs a PR runs). Run: `npm run test:unit`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AREAS, CORE, FULL_ONLY, SMOKE, buildGraph, selectSpecs } from './select-e2e.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_SPECS = readdirSync(path.join(ROOT, 'e2e'))
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => `e2e/${f}`);

const graph = buildGraph();
const noDiff = () => ({ added: [], removed: [] });
const pick = (changed, extra = {}) => selectSpecs(changed, { graph, diff: noDiff, ...extra });
const sorted = (specs) => [...new Set(specs)].sort();

describe('select-e2e', () => {
  test('every spec in e2e/ belongs to the smoke set or an area, so none is silently skipped on PRs', () => {
    const covered = new Set([...SMOKE, ...FULL_ONLY, ...AREAS.flatMap((a) => a.specs)]);
    const missing = ALL_SPECS.filter((s) => !covered.has(s));
    assert.deepEqual(missing, [], `add these specs to an area in scripts/select-e2e.mjs: ${missing.join(', ')}`);
  });

  test('every spec an area names exists', () => {
    const names = new Set(ALL_SPECS);
    const unknown = AREAS.flatMap((a) => a.specs).concat(SMOKE, FULL_ONLY, CORE).filter((s) => !names.has(s));
    assert.deepEqual(unknown, []);
  });

  test('no change runs the whole suite on a PR: the client core, test setup and infrastructure run CORE', () => {
    for (const f of ['src/store/session.ts', 'src/lib/matrix/actions.ts', 'e2e/fixtures/auth.ts', 'src/styles/global.css', '.github/workflows/ci.yml']) {
      const s = pick([f]);
      assert.ok(s.length < ALL_SPECS.length / 2, `${f} picked ${s.length} specs`);
      for (const c of CORE) assert.ok(s.includes(c), `${f} must run ${c}`);
    }
    assert.deepEqual(pick(['.github/workflows/ci.yml']), sorted([...CORE, ...FULL_ONLY]));
  });

  test('a voice change runs voice, encrypted media and threads, plus smoke', () => {
    const s = pick(['src/lib/audio/encode.ts', 'src/features/conversation/components/VoiceMessage.tsx']);
    for (const spec of ['e2e/voice.spec.ts', 'e2e/voice-compat.spec.ts', 'e2e/ogg-remux.spec.ts', 'e2e/e2ee-media.spec.ts', 'e2e/threads.spec.ts', ...SMOKE]) assert.ok(s.includes(spec), spec);
    assert.ok(!s.includes('e2e/gif.spec.ts'));
  });

  test('a GIF or link preview change runs that area only, plus smoke', () => {
    assert.deepEqual(pick(['src/features/gif/components/GifPicker.tsx']), sorted([...SMOKE, 'e2e/gif.spec.ts', 'e2e/mobile-gif.spec.ts']));
    assert.deepEqual(pick(['src/lib/preview/fetch.ts']), sorted([...SMOKE, 'e2e/link-preview.spec.ts', 'e2e/mobile-link-preview.spec.ts']));
  });

  test('a conversation component runs the conversation area, not every area above it', () => {
    const s = pick(['src/features/conversation/components/MessageList.tsx']);
    assert.ok(s.includes('e2e/conversation-timeline.spec.ts'));
    assert.ok(!s.includes('e2e/gif.spec.ts'));
  });

  test('a fixture runs the specs that import it, and a CSS module runs its component', () => {
    const s = pick(['e2e/fixtures/gif.ts']);
    assert.ok(s.includes('e2e/gif.spec.ts') && s.includes('e2e/mobile-gif.spec.ts'));
    assert.ok(!s.includes('e2e/voice.spec.ts'));
    assert.ok(pick(['src/features/gif/components/GifPicker.module.css']).includes('e2e/gif.spec.ts'));
  });

  test('docs-only changes run just the smoke set; a changed spec runs itself', () => {
    assert.deepEqual(pick(['docs/STATUS.md', 'README.md']), sorted(SMOKE));
    assert.deepEqual(pick(['e2e/navigation.spec.ts']), sorted([...SMOKE, 'e2e/navigation.spec.ts']));
  });

  test('package.json: a feature dependency runs the code that imports it; scripts or core dependencies run CORE', () => {
    const base = { scripts: { dev: 'vite' }, dependencies: { react: '18', 'gif-lib': '1.0' } };
    const bumped = { ...base, dependencies: { ...base.dependencies, 'gif-lib': '1.1' } };
    const withGifLib = { ...graph, packageUsers: new Map(graph.packageUsers).set('gif-lib', new Set(['src/features/gif/components/GifPicker.tsx'])) };
    const s = selectSpecs(['package.json', 'package-lock.json'], { graph: withGifLib, diff: noDiff, packageJson: { base, head: bumped } });
    assert.deepEqual(s, sorted([...SMOKE, 'e2e/gif.spec.ts', 'e2e/mobile-gif.spec.ts']));
    const react = { ...base, dependencies: { ...base.dependencies, react: '19' } };
    assert.deepEqual(pick(['package.json'], { packageJson: { base, head: react } }), sorted(CORE));
    assert.deepEqual(pick(['package-lock.json']), sorted(CORE));
  });

  test('playwright.config.ts: a project list change runs the specs it adds; anything else runs CORE and the harness', () => {
    const lists = () => ({
      removed: ['      testMatch: /(voice|mobile-nav)\\.spec\\.ts$/,'],
      added: ['      testMatch: /(voice|mobile-nav|mobile-gif)\\.spec\\.ts$/,', ' * a comment'],
    });
    assert.deepEqual(pick(['playwright.config.ts'], { diff: lists }), sorted([...SMOKE, 'e2e/mobile-gif.spec.ts']));
    const other = () => ({ removed: ['  retries: 1,'], added: ['  retries: 2,'] });
    assert.deepEqual(pick(['playwright.config.ts'], { diff: other }), sorted([...CORE, ...FULL_ONLY]));
  });

  test('a workflow change runs CORE and the harness, unless only comments and concurrency changed', () => {
    const wf = ['.github/workflows/ci.yml'];
    const concurrency = () => ({
      removed: ["  cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
      added: ['# A newer push cancels the older run.', '  cancel-in-progress: true'],
    });
    assert.deepEqual(pick(wf, { diff: concurrency }), sorted(SMOKE));
    const steps = () => ({ removed: ['    timeout-minutes: 15'], added: ['    timeout-minutes: 20'] });
    assert.deepEqual(pick(wf, { diff: steps }), sorted([...CORE, ...FULL_ONLY]));
  });

  test('devtools.ts runs the specs that read the hook keys it changes', () => {
    const s = pick(['src/app/devtools.ts'], { diff: () => ({ removed: [], added: ['    preview,'] }) });
    assert.ok(s.includes('e2e/link-preview.spec.ts'), 'preview hook readers');
    assert.ok(!s.includes('e2e/voice.spec.ts'));
  });
});
