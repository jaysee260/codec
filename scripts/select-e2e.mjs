#!/usr/bin/env node
/**
 * Picks the e2e specs a pull request needs, from the files it changes (CI's "E2E tests" job on PRs).
 *
 *   node scripts/select-e2e.mjs <base-ref>     prints the spec paths, space-separated
 *
 * A PR never runs the whole suite: pushes to master do, and so does a PR labelled `full-e2e` (.github/workflows/ci.yml).
 * The smoke walk-throughs (SMOKE) always run. For each changed file:
 *   - code under src/ or e2e/: follow the import graph up to everything that imports it. A file owned by a feature
 *     area (AREAS) adds that area's specs and ends the walk there; shared files keep walking; a spec reached runs
 *     itself. When that reaches more than half the suite (the client core: src/lib/matrix, src/store, the login and
 *     page fixtures), the PR runs CORE instead and master's full run covers the rest.
 *   - src/app/devtools.ts (the dev hooks the specs drive): the specs that read the `__matrixPoc` keys it changes
 *   - package.json: the areas whose code imports a dependency that changed; `scripts` or core dependencies
 *     (TOOLING) -> CORE. package-lock.json without package.json -> CORE.
 *   - playwright.config.ts: CORE + the harness checks, unless only comments and the projects' testMatch/testIgnore
 *     lists changed; then the specs newly named there
 *   - test infrastructure and global styles (INFRA): CORE + the harness checks (FULL_ONLY)
 *   - other files under src/, e2e/, public/ (CSS modules, recordings, images, preview pages): whatever imports or
 *     names them
 *   - docs, markdown, and anything else: nothing beyond smoke
 * scripts/select-e2e.test.mjs fails when a spec is in no area.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SMOKE = ['e2e/smoke.spec.ts', 'e2e/mobile-smoke.spec.ts'];

/** Test infrastructure and global styles: they can break any spec, so CORE and the harness checks run. */
export const INFRA = [
  /^e2e\/global-[^/]+$/,
  /^src\/styles\//,
  /^src\/app\/theme\.css$/,
  /^vite\.config\.ts$/,
  /^tsconfig\.json$/,
  /^index\.html$/,
  /^seed\//,
  /^homeserver\//,
  /^scripts\/(hs|hs-pool|rtc|rtc-probe)\.mjs$/,
  /^scripts\/lib\//,
  /^\.github\/workflows\//,
];

/** Dependencies that every page or the test run itself sits on (-> CORE). */
export const TOOLING = /^(@playwright\/|playwright$|vite$|@vitejs\/|typescript$|react$|react-dom$|matrix-js-sdk$|@matrix-org\/|zustand$)/;

const E2EE = [
  'e2e/e2ee-core-boot.spec.ts',
  'e2e/e2ee-core-timeline.spec.ts',
  'e2e/e2ee-media.spec.ts',
  'e2e/e2ee-recovery-lost-backup.spec.ts',
  'e2e/e2ee-recovery-second-key.spec.ts',
  'e2e/e2ee-security-chain.spec.ts',
  'e2e/e2ee-security-regressions.spec.ts',
];
const VOICE = ['e2e/voice.spec.ts', 'e2e/voice-compat.spec.ts', 'e2e/ogg-remux.spec.ts', 'e2e/e2ee-media.spec.ts', 'e2e/threads.spec.ts'];
const THREADS = ['e2e/threads.spec.ts', 'e2e/mobile-threads.spec.ts', 'e2e/e2ee-core-timeline.spec.ts'];
const LINK_PREVIEW = ['e2e/link-preview.spec.ts', 'e2e/mobile-link-preview.spec.ts'];
// QA-35..37 add call-room.spec.ts / mobile-call.spec.ts here as they land (the unit test refuses names that do not exist yet).
const CALLS = ['e2e/calls-core.spec.ts', 'e2e/call-dm.spec.ts', 'e2e/call-room.spec.ts', 'e2e/mobile-call.spec.ts'];
const GIF = ['e2e/gif.spec.ts', 'e2e/mobile-gif.spec.ts'];
const CONVERSATION = [
  'e2e/conversation-compose.spec.ts',
  'e2e/conversation-messages.spec.ts',
  'e2e/conversation-timeline.spec.ts',
  'e2e/e2ee-core-timeline.spec.ts',
  'e2e/e2ee-media.spec.ts',
  'e2e/auth-media.spec.ts',
  'e2e/mobile-nav.spec.ts',
];

/**
 * Feature areas: the src files each one owns (first match wins) and the specs that cover them. Overlaps are
 * deliberate (voice notes live in threads and E2EE).
 */
export const AREAS = [
  { name: 'calls', match: /^src\/(lib\/rtc\/|store\/call\.ts$|features\/call\/)/, specs: CALLS },
  { name: 'voice', match: /^src\/lib\/audio\/|^src\/features\/conversation\/(components\/Voice|hooks\/useVoiceRecorder)/, specs: VOICE },
  { name: 'link-preview', match: /^src\/(features\/link-preview|lib\/preview)\/|^src\/features\/conversation\/components\/LinkPreviews/, specs: LINK_PREVIEW },
  { name: 'gif', match: /^src\/(features|lib)\/gif\/|^src\/features\/conversation\/components\/Gif/, specs: GIF },
  { name: 'threads', match: /^src\/features\/(conversation\/components\/Thread|navigation\/components\/ThreadList)/, specs: THREADS },
  { name: 'conversation', match: /^src\/features\/conversation\//, specs: CONVERSATION },
  { name: 'navigation', match: /^src\/features\/navigation\//, specs: ['e2e/navigation.spec.ts', 'e2e/mobile-nav.spec.ts', 'e2e/e2ee-core-boot.spec.ts'] },
  { name: 'security', match: /^src\/features\/security\//, specs: E2EE },
  // Login, layout and the app frame. Shared code that only the shell uses ends up here.
  { name: 'shell', match: /^src\/(app\/|main\.tsx$)/, specs: ['e2e/shell.spec.ts', 'e2e/mobile-nav.spec.ts'] },
];

/** Specs that guard the test setup and the homeserver contract: run for INFRA changes and the files they import. */
export const FULL_ONLY = ['e2e/test-harness.spec.ts', 'e2e/homeserver-config.spec.ts'];

/** What a change to the client core runs on a PR: both walk-throughs, login/logout, and crypto boot. */
export const CORE = [...SMOKE, 'e2e/shell.spec.ts', 'e2e/e2ee-core-boot.spec.ts'];

const DOCS = /(^docs\/|\.md$|^LICENSE)/;
const CODE = /\.(ts|tsx|mjs|js)$/;
const DEVTOOLS = 'src/app/devtools.ts';

// ------------------------------------------------------------------------------------------------- import graph

function walk(root, dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'results' || name === 'tmp' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return out;
}

const SPECIFIER = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function resolveSpecifier(from, spec, files) {
  let base;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return { pkg: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] };
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (files.has(c)) return { file: c };
  return {};
}

/**
 * The import graph of src/, e2e/ and playwright.config.ts: `importers.get(f)` = files importing f directly,
 * `packageUsers.get(pkg)` = files importing that package, `texts` = code file contents (for name lookups).
 */
export function buildGraph(root = ROOT) {
  const all = [...walk(root, path.join(root, 'src')), ...walk(root, path.join(root, 'e2e')), 'playwright.config.ts'];
  const files = new Set(all.filter((f) => existsSync(path.join(root, f))));
  const importers = new Map();
  const packageUsers = new Map();
  const texts = new Map();
  const add = (map, key, value) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(value);
  for (const f of files) {
    if (!CODE.test(f)) continue;
    const text = readFileSync(path.join(root, f), 'utf8');
    texts.set(f, text);
    for (const m of text.matchAll(SPECIFIER)) {
      const r = resolveSpecifier(f, m[1] ?? m[2] ?? m[3], files);
      if (r.file) add(importers, r.file, f);
      if (r.pkg) add(packageUsers, r.pkg, f);
    }
  }
  return { importers, packageUsers, texts };
}

// ------------------------------------------------------------------------------------------------------ selection

const isSpec = (f) => /^e2e\/[^/]+\.spec\.ts$/.test(f);
const isComment = (line) => /^\s*(\*|\/\/|\/\*|$)/.test(line);

/**
 * Adds the specs covering `start`: walk up its importers, ending at area-owned files and at specs. A file most of the
 * suite depends on adds CORE instead.
 */
function addSpecsFor(start, graph, out) {
  const found = new Set();
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (isSpec(f)) {
      found.add(f);
      continue;
    }
    const area = f.startsWith('src/') ? AREAS.find((a) => a.match.test(f)) : undefined;
    if (area) {
      area.specs.forEach((s) => found.add(s));
      continue;
    }
    for (const i of graph.importers.get(f) ?? []) queue.push(i);
  }
  const suite = [...graph.texts.keys()].filter(isSpec).length;
  for (const s of found.size > suite / 2 ? CORE : found) out.add(s);
}

/** Code files that mention `file` by name (a recording, an image, a preview page). */
function codeNaming(file, graph) {
  const name = path.posix.basename(file);
  return [...graph.texts].filter(([, text]) => text.includes(name)).map(([f]) => f);
}

/** e2e files that read `window.__matrixPoc.<key>`. */
function hookReaders(key, graph) {
  const re = new RegExp(`__matrixPoc\\??\\.${key}\\b`);
  return [...graph.texts].filter(([f, text]) => f.startsWith('e2e/') && re.test(text)).map(([f]) => f);
}

/**
 * @param {string[]} changed repo-relative paths
 * @param {{ graph: ReturnType<typeof buildGraph>, diff: (file: string) => { added: string[], removed: string[] },
 *   packageJson?: { base: any, head: any } }} ctx
 * @returns {string[]}
 */
export function selectSpecs(changed, ctx) {
  const specs = new Set(SMOKE);
  const core = (harness = false) => [...CORE, ...(harness ? FULL_ONLY : [])].forEach((s) => specs.add(s));
  const { graph } = ctx;
  for (const file of changed) {
    if (INFRA.some((re) => re.test(file))) {
      core(true);
      continue;
    }
    if (DOCS.test(file)) continue;

    if (file === 'package-lock.json') {
      if (!changed.includes('package.json')) core();
      continue; // otherwise judged by its package.json change
    }
    if (file === 'package.json') {
      const { base, head } = ctx.packageJson ?? {};
      if (JSON.stringify(base?.scripts) !== JSON.stringify(head?.scripts)) core();
      const deps = (p) => ({ ...p?.dependencies, ...p?.devDependencies });
      const before = deps(base);
      const after = deps(head);
      const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((n) => before[n] !== after[n]);
      if (names.some((n) => TOOLING.test(n))) core();
      for (const n of names.filter((n) => !TOOLING.test(n))) for (const f of graph.packageUsers.get(n) ?? []) addSpecsFor(f, graph, specs);
      continue;
    }
    if (file === 'playwright.config.ts') {
      const { added, removed } = ctx.diff(file);
      if (![...added, ...removed].filter((l) => !isComment(l)).every((l) => /test(Match|Ignore):/.test(l))) core(true);
      const named = (lines) => new Set(lines.flatMap((l) => [...l.matchAll(/[|(]([\w-]+)(?=[|)])/g)].map((m) => m[1])));
      const before = named(removed);
      for (const n of named(added)) if (!before.has(n) && graph.texts.has(`e2e/${n}.spec.ts`)) specs.add(`e2e/${n}.spec.ts`);
      continue;
    }
    if (file === DEVTOOLS) {
      const { added, removed } = ctx.diff(file);
      const words = new Set([...added, ...removed].filter((l) => !isComment(l)).flatMap((l) => l.match(/[A-Za-z_]\w*/g) ?? []));
      for (const key of words) for (const f of hookReaders(key, graph)) addSpecsFor(f, graph, specs);
      continue;
    }
    if (!/^(src|e2e|public)\//.test(file)) continue; // android/, ios/, sample scripts: no e2e coverage beyond smoke
    if (CODE.test(file)) addSpecsFor(file, graph, specs);
    else for (const f of graph.importers.get(file) ?? codeNaming(file, graph)) addSpecsFor(f, graph, specs);
  }
  return [...specs].sort();
}

// --------------------------------------------------------------------------------------------------------- CLI

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** Added / removed lines of a file between the merge base of `base` and HEAD. */
export function gitDiff(base) {
  return (file) => {
    const out = git(['diff', '-U0', `${base}...HEAD`, '--', file]).split('\n');
    return {
      added: out.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)),
      removed: out.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1)),
    };
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: node scripts/select-e2e.mjs <base-ref>');
    process.exit(2);
  }
  const changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').map((s) => s.trim()).filter(Boolean);
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const result = selectSpecs(changed, {
    graph: buildGraph(),
    diff: gitDiff(base),
    packageJson: {
      base: JSON.parse(git(['show', `${mergeBase}:package.json`])),
      head: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')),
    },
  });
  console.log(result.join(' '));
}
