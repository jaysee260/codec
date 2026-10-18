#!/usr/bin/env node
/**
 * Picks the e2e specs a pull request needs, from the files it changes (CI's "E2E tests" job on PRs).
 *
 *   node scripts/select-e2e.mjs <base-ref>     prints "ALL" or the spec paths, space-separated
 *
 * Rules, first match per changed file:
 *   - shared code or test setup (FULL_PATTERNS)      -> the whole suite ("ALL")
 *   - a feature area (AREAS)                         -> that area's specs
 *   - an e2e spec itself                             -> that spec
 *   - docs / markdown                                -> nothing extra
 *   - anything else under src/                       -> "ALL" (unknown code is treated as shared)
 * The smoke walk-throughs (SMOKE) always run. Pushes to master and the `full-e2e` label run everything
 * (.github/workflows/ci.yml); scripts/select-e2e.test.mjs fails when a spec is in no area.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SMOKE = ['e2e/smoke.spec.ts', 'e2e/mobile-smoke.spec.ts'];

/** Changing any of these can break any feature, so the whole suite runs. */
export const FULL_PATTERNS = [
  /^src\/lib\/matrix\//,
  /^src\/store\//,
  /^src\/app\//,
  /^src\/main\.tsx$/,
  /^src\/styles\//,
  /^src\/lib\/(format|native)\.ts$/,
  /^e2e\/fixtures\//,
  /^e2e\/global-[^/]+$/,
  /^playwright\.config\.ts$/,
  /^package(-lock)?\.json$/,
  /^vite\.config\.ts$/,
  /^tsconfig\.json$/,
  /^index\.html$/,
  /^seed\//,
  /^homeserver\//,
  /^scripts\/(hs|hs-pool)\.mjs$/,
  /^scripts\/lib\//,
  /^\.github\/workflows\//,
];

const E2EE = [
  'e2e/e2ee-core-boot.spec.ts',
  'e2e/e2ee-core-timeline.spec.ts',
  'e2e/e2ee-media.spec.ts',
  'e2e/e2ee-recovery-second-key.spec.ts',
  'e2e/e2ee-security-chain.spec.ts',
  'e2e/e2ee-security-regressions.spec.ts',
];
const VOICE = ['e2e/voice.spec.ts', 'e2e/e2ee-media.spec.ts', 'e2e/threads.spec.ts'];
const LINK_PREVIEW = ['e2e/link-preview.spec.ts', 'e2e/mobile-link-preview.spec.ts'];
const CONVERSATION = [
  'e2e/conversation-compose.spec.ts',
  'e2e/conversation-messages.spec.ts',
  'e2e/conversation-timeline.spec.ts',
  'e2e/threads.spec.ts',
  'e2e/mobile-threads.spec.ts',
  'e2e/e2ee-core-timeline.spec.ts',
  'e2e/auth-media.spec.ts',
  ...VOICE,
  ...LINK_PREVIEW,
];

/** Feature areas: changed paths -> the specs that cover them. Overlaps are deliberate (voice notes live in threads and E2EE). */
export const AREAS = [
  { name: 'voice', match: /^src\/lib\/audio\/|^src\/features\/conversation\/(components\/Voice|hooks\/useVoiceRecorder)/, specs: VOICE },
  { name: 'link-preview', match: /^src\/(features\/link-preview|lib\/preview)\/|^src\/features\/conversation\/components\/LinkPreviews|^public\/preview-fixtures\//, specs: LINK_PREVIEW },
  { name: 'conversation', match: /^src\/features\/conversation\//, specs: CONVERSATION },
  { name: 'navigation', match: /^src\/features\/navigation\//, specs: ['e2e/navigation.spec.ts', 'e2e/mobile-nav.spec.ts', 'e2e/shell.spec.ts'] },
  { name: 'gif', match: /^src\/(features|lib)\/gif\//, specs: ['e2e/gif.spec.ts', 'e2e/mobile-gif.spec.ts'] },
  { name: 'security', match: /^src\/features\/security\//, specs: E2EE },
];

/** Specs that guard the test setup and the homeserver contract: they only run with the whole suite (FULL_PATTERNS). */
export const FULL_ONLY = ['e2e/test-harness.spec.ts', 'e2e/homeserver-config.spec.ts'];

const DOCS = /(^docs\/|\.md$|^LICENSE)/;

/** @param {string[]} changed repo-relative paths. @returns {'ALL' | string[]} */
export function selectSpecs(changed) {
  const specs = new Set(SMOKE);
  for (const file of changed) {
    if (FULL_PATTERNS.some((re) => re.test(file))) return 'ALL';
    const area = AREAS.find((a) => a.match.test(file));
    if (area) {
      area.specs.forEach((s) => specs.add(s));
      continue;
    }
    if (/^e2e\/[^/]+\.spec\.ts$/.test(file)) {
      specs.add(file);
      continue;
    }
    if (DOCS.test(file)) continue;
    if (file.startsWith('src/')) return 'ALL';
    // Everything else (android/, ios/, scripts that only post samples, public/) has no e2e coverage beyond smoke.
  }
  return [...specs].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: node scripts/select-e2e.mjs <base-ref>');
    process.exit(2);
  }
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
  const changed = out.split('\n').map((s) => s.trim()).filter(Boolean);
  const result = selectSpecs(changed);
  console.log(result === 'ALL' ? 'ALL' : result.join(' '));
}
