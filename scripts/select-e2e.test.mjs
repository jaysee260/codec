/**
 * Unit tests for scripts/select-e2e.mjs (which e2e specs a PR runs). Run: `npm run test:unit`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AREAS, FULL_ONLY, SMOKE, selectSpecs } from './select-e2e.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_SPECS = readdirSync(path.join(ROOT, 'e2e'))
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => `e2e/${f}`);

describe('select-e2e', () => {
  test('every spec in e2e/ belongs to the smoke set or an area, so none is silently skipped on PRs', () => {
    const covered = new Set([...SMOKE, ...FULL_ONLY, ...AREAS.flatMap((a) => a.specs)]);
    const missing = ALL_SPECS.filter((s) => !covered.has(s));
    assert.deepEqual(missing, [], `add these specs to an area in scripts/select-e2e.mjs: ${missing.join(', ')}`);
  });

  test('every spec an area names exists', () => {
    const names = new Set(ALL_SPECS);
    const unknown = AREAS.flatMap((a) => a.specs).concat(SMOKE, FULL_ONLY).filter((s) => !names.has(s));
    assert.deepEqual(unknown, []);
  });

  test('shared code, test setup and dependencies run the whole suite', () => {
    for (const f of [
      'src/lib/matrix/actions.ts',
      'src/store/session.ts',
      'src/app/devtools.ts',
      'e2e/fixtures/matrix-api.ts',
      'playwright.config.ts',
      'package-lock.json',
      '.github/workflows/ci.yml',
      'src/features/brand-new/Thing.tsx',
    ]) {
      assert.equal(selectSpecs([f]), 'ALL', f);
    }
  });

  test('a voice change runs voice, encrypted media and threads, plus smoke', () => {
    const s = selectSpecs(['src/lib/audio/ogg.ts', 'src/features/conversation/components/VoiceMessage.tsx']);
    assert.notEqual(s, 'ALL');
    for (const spec of ['e2e/voice.spec.ts', 'e2e/e2ee-media.spec.ts', 'e2e/threads.spec.ts', ...SMOKE]) {
      assert.ok(s.includes(spec), spec);
    }
    assert.ok(!s.includes('e2e/gif.spec.ts'));
  });

  test('a GIF change runs the GIF specs only, plus smoke', () => {
    assert.deepEqual(selectSpecs(['src/features/gif/GifPicker.tsx']), [...SMOKE, 'e2e/gif.spec.ts', 'e2e/mobile-gif.spec.ts'].sort());
  });

  test('a link preview change runs the link preview specs only, plus smoke', () => {
    assert.deepEqual(selectSpecs(['src/lib/preview/fetch.ts']), [...SMOKE, 'e2e/link-preview.spec.ts', 'e2e/mobile-link-preview.spec.ts'].sort());
  });

  test('docs-only changes run just the smoke set; a changed spec runs itself', () => {
    assert.deepEqual(selectSpecs(['docs/STATUS.md', 'README.md']), [...SMOKE].sort());
    assert.deepEqual(selectSpecs(['e2e/navigation.spec.ts']), [...SMOKE, 'e2e/navigation.spec.ts'].sort());
  });
});
