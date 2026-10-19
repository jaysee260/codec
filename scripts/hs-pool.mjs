#!/usr/bin/env node
/**
 * Homeserver pool for parallel e2e runs (issue #2): N Synapse instances, every one a byte copy of ONE seeded
 * snapshot, so room ids / event ids in seed/seed-output.json and the keys in seed/e2ee-keys.json are valid on all of
 * them unchanged. Playwright's globalSetup (e2e/global-setup.ts) calls `up` / `down`; the commands also work by hand.
 *
 *   node scripts/hs-pool.mjs snapshot [--force]   build (or refresh) the seeded snapshot: start a template Synapse,
 *                                                 run seed/seed.ts + scripts/send-encrypted-sample.mjs, stop, keep the
 *                                                 data dir. Cached under homeserver/data/pool/snapshot, keyed by a hash of
 *                                                 the seed inputs + Synapse version; rebuilt only when that changes.
 *   node scripts/hs-pool.mjs up [--workers N] [--replace]
 *                                                 restore N fresh copies and start them on 8008..8008+N-1 (default N:
 *                                                 E2E_WORKERS or the e2e default); copies the snapshot's seed files back
 *                                                 into seed/. Builds the snapshot first when it is missing or stale.
 *   node scripts/hs-pool.mjs down                 stop every instance the last `up` started (data dirs + logs kept)
 *   node scripts/hs-pool.mjs status               what is running / answering
 *   node scripts/hs-pool.mjs clean                down + delete the pool dirs and the snapshot
 *   node scripts/hs-pool.mjs probe                exit 0 when a backend is usable, else print why and exit 1 (quick;
 *                                                 e2e/fixtures/pool.ts uses it on Windows for the WSL1 fallback)
 *
 * Phase 7 (voice calls): `up` also starts one local call stack per instance (LiveKit SFU + LiveKit auth service,
 * scripts/lib/rtc-stack.mjs: ports 7880+i / 7980+i, pids in state.json, config + logs in hs-<i>/) and each instance's
 * well-known `rtc_foci` points at its own auth service, so Playwright workers never share a call server. The LiveKit
 * binary is fetched once into homeserver/.rtc/ (`node scripts/rtc.mjs fetch`; CI caches it). `E2E_NO_RTC=1` skips
 * the call stacks (the call specs then fail; everything else runs).
 *
 * Layout (all under homeserver/data/pool/, git-ignored):
 *   snapshot/data/        homeserver.db, media_store, localhost.signing.key, secrets/   (the seeded template)
 *   snapshot/seed/        seed-output.json, e2ee-keys.json, assets/                     (restored into seed/ by `up`)
 *   snapshot/meta.json    { hash, backend, version, builtAt, buildMs }
 *   hs-<i>/               instance i: a copy of snapshot/data + homeserver.yaml, log.config, synapse.log
 *   state.json            instances started by the last `up` (pids, ports)
 *
 * Environment: E2E_WORKERS, HS_POOL_BACKEND=native|docker (default: native when its venv works, else docker when
 *              `docker info` works), SYNAPSE_PYTHON (native), SYNAPSE_IMAGE (docker),
 *              HS_POOL_BUILD_PORT (default 8040; the template's port while seeding), HS_POOL_BASE_PORT (default 8008).
 * Backends live in scripts/lib/hs-<name>.mjs and share the contract documented in hs-native.mjs.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DEFAULT_HS_PORT, ROOT, ensureSecrets, renderInstanceConfig, renderLogConfig, waitForHomeserver } from './lib/hs-config.mjs';
import { dockerBackend } from './lib/hs-docker.mjs';
import { native } from './lib/hs-native.mjs';
import { ensureLivekitBinary, jwtUrlFor, rtcStackAlive, rtcStackStatus, startRtcStack, stopRtcStack } from './lib/rtc-stack.mjs';

const NO_RTC = !!process.env.E2E_NO_RTC;

export const POOL_DIR = path.join(DATA_DIR, 'pool');
const SNAPSHOT_DIR = path.join(POOL_DIR, 'snapshot');
const TEMPLATE_DIR = path.join(POOL_DIR, 'template');
/**
 * Instances and state live per base port, so a manual pool on HS_POOL_BASE_PORT=8020 (agents' checks) never sees or
 * stops the default one on 8008 that a Playwright run owns. The snapshot is shared.
 */
const RUN_DIR = Number(process.env.HS_POOL_BASE_PORT ?? DEFAULT_HS_PORT) === DEFAULT_HS_PORT ? POOL_DIR : path.join(POOL_DIR, `base-${Number(process.env.HS_POOL_BASE_PORT)}`);
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const SEED_DIR = path.join(ROOT, 'seed');
const BASE_PORT = Number(process.env.HS_POOL_BASE_PORT ?? DEFAULT_HS_PORT);
const BUILD_PORT = Number(process.env.HS_POOL_BUILD_PORT ?? 8040);
/** Phase 7: call-stack instance index of pool instance i (scripts/lib/rtc-stack.mjs port plan); offset per base port. */
const rtcIndexOf = (i) => i + (BASE_PORT - DEFAULT_HS_PORT);
/** Bump when the snapshot layout or the build steps change, so old caches are rebuilt. */
const POOL_FORMAT = 1;

/** Everything whose change must invalidate the snapshot (seed/assets/*.png are derived from seed.ts, not inputs). */
const SNAPSHOT_INPUTS = [
  'seed/seed.ts',
  'homeserver/homeserver.yaml',
  'homeserver/localhost.log.config',
  'scripts/hs-pool.mjs',
  'scripts/send-encrypted-sample.mjs',
  'scripts/lib/e2ee-api.mjs',
  'scripts/lib/gif-api.mjs',
  'scripts/lib/hs-config.mjs',
  'e2e/fixtures/test-image.png',
];
/** Files the seed step produces that every run needs next to the tests; carried in the snapshot. */
const SEED_OUTPUTS = ['seed-output.json', 'e2ee-keys.json', 'assets'];

/** Auto-selection tries these in order: native (a venv/python with synapse), then docker (`docker info` works). */
const BACKENDS = { native, docker: dockerBackend };

export const hsUrl = (port) => `http://localhost:${port}`;
export const defaultWorkers = () => Math.max(1, Math.min(4, os.cpus().length - 1));
const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** The first usable backend, or the reasons none is (one line per backend tried). */
function findBackend(probeOpts) {
  const forced = process.env.HS_POOL_BACKEND;
  const names = forced ? [forced] : Object.keys(BACKENDS);
  const reasons = [];
  for (const name of names) {
    const backend = BACKENDS[name];
    if (!backend) throw new Error(`HS_POOL_BACKEND=${name}: unknown backend (known: ${Object.keys(BACKENDS).join(', ')})`);
    const why = backend.available(probeOpts);
    if (!why) return { backend, reasons };
    reasons.push(`${name}: ${why}`);
  }
  return { backend: null, reasons };
}

/** null when the pool can run here, else why not. Quick (docker probe capped at 3 s): `probe` runs it at config load. */
export function poolBackendProblem() {
  const { backend, reasons } = findBackend({ timeoutMs: 3000 });
  return backend ? null : reasons.join('; ');
}

function pickBackend() {
  const { backend, reasons } = findBackend();
  if (backend) return backend;
  throw new Error(
    `No usable homeserver pool backend.\n  ${reasons.join('\n  ')}\n` +
      'Set up one of: a Synapse venv (python3 -m venv homeserver/.venv && homeserver/.venv/bin/pip install matrix-synapse), ' +
      'or Docker. See homeserver/README.md.',
  );
}

async function answering(port) {
  try {
    const res = await fetch(`${hsUrl(port)}/_matrix/client/versions`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function tail(file, lines = 30) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function run(cmd, args, { env = {}, logFile, label }) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  if (logFile) writeFileSync(logFile, `$ ${cmd} ${args.join(' ')}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`, { flag: 'a' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${label ?? cmd} failed (exit ${r.status}):\n${(r.stderr || r.stdout || '').trimEnd().split('\n').slice(-25).join('\n')}`);
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

function instanceDir(i) {
  return path.join(RUN_DIR, `hs-${i}`);
}

/** Writes homeserver.yaml + log.config into `dir` for a Synapse on `port` (Phase 7: well-known -> instance `rtcIndex`'s auth service). */
function writeInstanceConfig(backend, dir, port, rtcIndex = 0) {
  const configPath = path.join(dir, 'homeserver.yaml');
  writeFileSync(configPath, renderInstanceConfig({ port, dataRoot: backend.dataRoot(dir), hsUrl: hsUrl(port), bindAddresses: backend.bindAddresses, rtcJwtUrl: jwtUrlFor(rtcIndex) }));
  writeFileSync(path.join(dir, 'log.config'), renderLogConfig());
  return configPath;
}

async function startInstance(backend, { index, dir, port }) {
  const configPath = writeInstanceConfig(backend, dir, port, typeof index === 'number' ? rtcIndexOf(index) : 0);
  const logPath = path.join(dir, 'synapse.log');
  const handle = backend.start({ dir, port, configPath, logPath });
  const inst = { index, port, url: hsUrl(port), dir, logPath, ...handle };
  await waitForHomeserver(inst.url, 120_000, {
    interval: 250,
    abort: () => (backend.alive(inst) ? null : `exit; last log lines:\n${tail(logPath)}`),
    onTimeout: () => console.error(`[hs-pool] ${inst.url} did not come up; last log lines:\n${tail(logPath)}`),
  });
  return inst;
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function stopState(backend, state, { quiet = false } = {}) {
  if (!state) return 0;
  let stopped = 0;
  let rtcStopped = 0;
  for (const inst of state.instances) {
    if (await backend.stop(inst)) stopped++;
    if (await stopRtcStack(inst.rtc)) rtcStopped++;
  }
  rmSync(STATE_FILE, { force: true });
  if (!quiet) console.log(`[hs-pool] stopped ${stopped}/${state.instances.length} instance(s), ${rtcStopped} call stack(s)`);
  return stopped;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function snapshotHash(backend) {
  const h = createHash('sha256');
  h.update(`format:${POOL_FORMAT}\n`);
  h.update(`backend:${backend.name} ${backend.version()}\n`);
  for (const rel of SNAPSHOT_INPUTS) {
    const file = path.join(ROOT, rel);
    h.update(`${rel}\n`);
    if (existsSync(file)) h.update(readFileSync(file));
  }
  return h.digest('hex').slice(0, 16);
}

function readMeta() {
  try {
    return JSON.parse(readFileSync(path.join(SNAPSHOT_DIR, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function snapshotIsFresh(backend) {
  const meta = readMeta();
  return !!meta && meta.hash === snapshotHash(backend) && existsSync(path.join(SNAPSHOT_DIR, 'data', 'homeserver.db'));
}

/** Best effort: fold a leftover WAL into the main db so the copy is self-contained. */
function checkpointSqlite(dbPath) {
  if (!existsSync(`${dbPath}-wal`)) return;
  spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close();`, dbPath], { stdio: 'ignore' });
}

export async function buildSnapshot(backend, { force = false } = {}) {
  const hash = snapshotHash(backend);
  if (!force && snapshotIsFresh(backend)) {
    console.log(`[hs-pool] snapshot ${hash} is up to date (${SNAPSHOT_DIR})`);
    return readMeta();
  }
  const t0 = Date.now();
  console.log(`[hs-pool] building snapshot ${hash} with ${backend.version()} on port ${BUILD_PORT} ...`);
  if (await answering(BUILD_PORT)) {
    throw new Error(`port ${BUILD_PORT} is already serving a homeserver; stop it or set HS_POOL_BUILD_PORT.`);
  }
  rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  mkdirSync(TEMPLATE_DIR, { recursive: true });
  ensureSecrets(TEMPLATE_DIR, { quiet: true });
  const buildLog = path.join(POOL_DIR, 'snapshot-build.log');
  rmSync(buildLog, { force: true });

  // seed.ts writes its ids to SEED_OUTPUT_FILE: inside the template, never into the checkout's seed/seed-output.json
  // (a live Playwright run may be reading that one; `up` installs the snapshot's copy when it restores).
  const outputFile = path.join(TEMPLATE_DIR, 'seed-output.json');

  const inst = await startInstance(backend, { index: 'template', dir: TEMPLATE_DIR, port: BUILD_PORT });
  console.log(`[hs-pool] template Synapse up on ${inst.url} (${fmtMs(Date.now() - t0)})`);
  try {
    const env = { HS_URL: inst.url, SEED_OUTPUT_FILE: outputFile };
    const t1 = Date.now();
    run(process.execPath, ['seed/seed.ts'], { env, logFile: buildLog, label: 'seed/seed.ts' });
    console.log(`[hs-pool] seed/seed.ts done (${fmtMs(Date.now() - t1)})`);
    const t2 = Date.now();
    const keysFile = path.join(TEMPLATE_DIR, 'e2ee-keys.json');
    run(process.execPath, ['scripts/send-encrypted-sample.mjs', '--keys', keysFile], { env, logFile: buildLog, label: 'scripts/send-encrypted-sample.mjs' });
    console.log(`[hs-pool] send-encrypted-sample.mjs done (${fmtMs(Date.now() - t2)})`);
    if (!existsSync(outputFile)) throw new Error(`seed/seed.ts did not write ${outputFile}`);
    await markVaultRead(inst.url, outputFile);
  } catch (e) {
    await backend.stop(inst);
    throw new Error(`${e.message}\n(full output: ${buildLog})`);
  }
  await backend.stop(inst);
  checkpointSqlite(path.join(TEMPLATE_DIR, 'homeserver.db'));

  // Assemble: template -> snapshot/data (+ seed files), atomically swap the old snapshot out.
  const staging = `${SNAPSHOT_DIR}.new`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.join(staging, 'seed'), { recursive: true });
  renameSync(path.join(TEMPLATE_DIR, 'e2ee-keys.json'), path.join(staging, 'seed', 'e2ee-keys.json'));
  renameSync(outputFile, path.join(staging, 'seed', 'seed-output.json'));
  for (const f of ['homeserver.yaml', 'log.config', 'homeserver.pid']) rmSync(path.join(TEMPLATE_DIR, f), { force: true });
  renameSync(path.join(TEMPLATE_DIR, 'synapse.log'), path.join(staging, 'template-synapse.log'));
  renameSync(TEMPLATE_DIR, path.join(staging, 'data'));
  for (const name of ['assets']) {
    const src = path.join(SEED_DIR, name);
    if (existsSync(src)) cpSync(src, path.join(staging, 'seed', name), { recursive: true });
  }
  const meta = { hash, backend: backend.name, version: backend.version(), builtAt: new Date().toISOString(), buildMs: Date.now() - t0 };
  writeFileSync(path.join(staging, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  renameSync(staging, SNAPSHOT_DIR);
  console.log(`[hs-pool] snapshot ${hash} built in ${fmtMs(meta.buildMs)} -> ${path.relative(ROOT, SNAPSHOT_DIR)} (${dirSizeMb(path.join(SNAPSHOT_DIR, 'data'))} MB)`);
  return meta;
}

/**
 * The e2ee sample leaves bob's 4 events unread for alice in #vault; docs/SEED_DATA.md promises the Acme channels other
 * than #random/#lobby start read (navigation AC-A5-2 depends on it), so alice reads #vault before the snapshot is taken.
 */
async function markVaultRead(hsUrl, outputFile) {
  const v3 = `${hsUrl}/_matrix/client/v3`;
  const json = async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.url} -> ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  const seed = JSON.parse(readFileSync(outputFile, 'utf8'));
  const vault = seed.rooms?.vault;
  if (!vault) throw new Error('seed-output.json has no "vault" room; cannot mark it read for alice');
  const login = await json(
    await fetch(`${v3}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: 'alice' }, password: 'password123', initial_device_display_name: 'hs-pool read marker' }),
    }),
  );
  const auth = { authorization: `Bearer ${login.access_token}`, 'content-type': 'application/json' };
  try {
    const room = encodeURIComponent(vault);
    const { chunk } = await json(await fetch(`${v3}/rooms/${room}/messages?dir=b&limit=1`, { headers: auth }));
    const last = chunk?.[0]?.event_id;
    if (!last) throw new Error('#vault has no events to mark read');
    await json(await fetch(`${v3}/rooms/${room}/read_markers`, { method: 'POST', headers: auth, body: JSON.stringify({ 'm.fully_read': last, 'm.read': last }) }));
    console.log(`[hs-pool] #vault marked read for alice at ${last}`);
  } finally {
    await fetch(`${v3}/logout`, { method: 'POST', headers: auth }).catch(() => {});
  }
}

function dirSizeMb(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += statSync(p).size;
    }
  };
  walk(dir);
  return (bytes / 1024 / 1024).toFixed(1);
}

/** Copies the snapshot's seed-output.json / e2ee-keys.json / assets into seed/ so the fixtures match the clones. */
function restoreSeedFiles() {
  // The default pool (8008) is what the fixtures use, so its seed files go to seed/. A pool on another base port
  // (manual checks while a Playwright run is live) gets them under its own dir and must not touch seed/.
  const target = RUN_DIR === POOL_DIR ? SEED_DIR : path.join(RUN_DIR, 'seed');
  mkdirSync(target, { recursive: true });
  if (target !== SEED_DIR) console.log(`[hs-pool] seed files for this pool: ${path.relative(ROOT, target)}/ (seed/ left alone)`);
  for (const name of SEED_OUTPUTS) {
    const src = path.join(SNAPSHOT_DIR, 'seed', name);
    if (!existsSync(src)) continue;
    const dst = path.join(target, name);
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function up({ workers, replace = false } = {}) {
  const n = Number(workers ?? process.env.E2E_WORKERS ?? defaultWorkers());
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error(`workers must be 1..16, got ${workers}`);
  const backend = pickBackend();
  mkdirSync(RUN_DIR, { recursive: true });

  const previous = readState();
  if (previous) {
    const prevBackend = BACKENDS[previous.backend] ?? backend;
    const alive = previous.instances.filter((inst) => prevBackend.alive(inst) || rtcStackAlive(inst.rtc));
    if (alive.length && !replace) {
      throw new Error(
        `a pool started ${previous.startedAt} is still running on ${alive.map((i) => i.port).join(', ')} (${STATE_FILE}). It may belong to a live Playwright run: leave it, or pass --replace to stop and restart it.`,
      );
    }
    console.log(alive.length ? '[hs-pool] --replace: stopping the previous pool first' : '[hs-pool] clearing stale state of a pool that is no longer running');
    await stopState(prevBackend, previous, { quiet: true });
  }
  for (let i = 0; i < n; i++) {
    if (await answering(BASE_PORT + i)) {
      throw new Error(
        `port ${BASE_PORT + i} is already serving a homeserver that this pool did not start. Stop it (\`npm run hs:down\`) or run the tests with E2E_REUSE_SERVERS=1 to use what is running.`,
      );
    }
  }
  await buildSnapshot(backend);
  // Phase 7: the call stacks need the LiveKit binary; fetch it before any instance starts (one download, cached).
  if (!NO_RTC) await ensureLivekitBinary();

  const t0 = Date.now();
  const planned = Array.from({ length: n }, (_, index) => ({ index, dir: instanceDir(index), port: BASE_PORT + index }));
  for (const p of planned) {
    rmSync(p.dir, { recursive: true, force: true });
    cpSync(path.join(SNAPSHOT_DIR, 'data'), p.dir, { recursive: true });
  }
  restoreSeedFiles();
  const restoreMs = Date.now() - t0;

  const state = { backend: backend.name, startedAt: new Date().toISOString(), instances: [] };
  const persist = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  try {
    const started = await Promise.all(
      planned.map(async (p) => {
        const inst = await startInstance(backend, p);
        if (!NO_RTC) inst.rtc = await startRtcStack({ index: rtcIndexOf(p.index), dir: p.dir, hsUrl: inst.url });
        state.instances.push(inst);
        persist();
        return inst;
      }),
    );
    state.instances = started.sort((a, b) => a.index - b.index);
    state.readyMs = Date.now() - t0;
    state.restoreMs = restoreMs;
    persist();
  } catch (e) {
    persist();
    await stopState(backend, state, { quiet: true });
    throw e;
  }
  console.log(
    `[hs-pool] ${n} homeserver(s) ready on ${state.instances.map((i) => i.port).join(', ')} (${backend.name}; restore ${fmtMs(restoreMs)}, ready ${fmtMs(state.readyMs)})` +
      (NO_RTC ? ' without call stacks (E2E_NO_RTC)' : `; call stacks on ${state.instances.map((i) => `${i.rtc.ports.lk}/${i.rtc.ports.jwt}`).join(', ')}`),
  );
  return state;
}

export async function down() {
  const state = readState();
  if (!state) {
    console.log('[hs-pool] nothing to stop (no state.json)');
    return 0;
  }
  const backend = BACKENDS[state.backend] ?? native;
  return stopState(backend, state);
}

async function status() {
  const meta = readMeta();
  console.log(meta ? `snapshot: ${meta.hash} (${meta.version}, built ${meta.builtAt}, ${fmtMs(meta.buildMs)})` : 'snapshot: none');
  const state = readState();
  if (!state) {
    console.log('pool: not running');
    return;
  }
  const backend = BACKENDS[state.backend] ?? native;
  for (const inst of state.instances) {
    console.log(`  hs-${inst.index}  ${inst.url}  ${inst.container ? `container ${inst.container}` : `pid ${inst.pid}`}  ${backend.alive(inst) ? 'alive' : 'DEAD'}  ${(await answering(inst.port)) ? 'answering' : 'not answering'}`);
    console.log(`           rtc: ${inst.rtc ? (rtcStackAlive(inst.rtc) ? '' : 'DEAD: ') + (await rtcStackStatus(inst.rtc)) : 'none'}`);
  }
}

async function clean() {
  await down();
  rmSync(POOL_DIR, { recursive: true, force: true });
  console.log(`[hs-pool] removed ${path.relative(ROOT, POOL_DIR)}`);
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'snapshot':
      await buildSnapshot(pickBackend(), { force: args.includes('--force') });
      return;
    case 'up':
      await up({ workers: argValue(args, '--workers'), replace: args.includes('--replace') });
      return;
    case 'down':
      await down();
      return;
    case 'status':
      await status();
      return;
    case 'clean':
      await clean();
      return;
    case 'fresh': {
      // `npm run test:e2e:fresh`: rebuild the seed snapshot (every pool run already restores a fresh copy). Where no
      // pool backend exists (the WSL1 fallback, which reuses :8008), reset and reseed that single server instead.
      const { backend } = findBackend({ timeoutMs: 3000 });
      if (backend) await buildSnapshot(backend, { force: true });
      else {
        run(process.execPath, ['scripts/hs.mjs', 'reset'], { label: 'hs.mjs reset' });
        run(process.execPath, ['seed/seed.ts'], { label: 'seed' });
      }
      return;
    }
    case 'probe': {
      const problem = poolBackendProblem();
      if (problem) {
        console.log(problem);
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.error('usage: node scripts/hs-pool.mjs <snapshot [--force]|fresh|up [--workers N] [--replace]|down|status|clean|probe>');
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[hs-pool] ${e.message ?? e}`);
    process.exit(1);
  });
}
