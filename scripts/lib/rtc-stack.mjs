/**
 * Phase 7: the local call stack, one per homeserver: a LiveKit SFU (`livekit-server`, pinned release) and the LiveKit
 * auth service (`scripts/lib/lk-jwt.mjs`). Used by `scripts/rtc.mjs` (the single dev stack next to `npm run hs:up`)
 * and by `scripts/hs-pool.mjs` (one stack per pooled Synapse, so Playwright workers never share a call server).
 *
 * Port plan for instance i (0 = the dev stack / worker 0; the pool uses i = worker + (HS_POOL_BASE_PORT - 8008), so a
 * manual pool on 8020 lands on 7892.. and never clashes with a Playwright run's 7880..7887; i < 20):
 *   LiveKit signalling (HTTP + WebSocket)   7880 + i    `ws://localhost:7880+i`, what `/sfu/get` hands back as `url`
 *   LiveKit media TCP fallback              7920 + i
 *   LiveKit media UDP (single port mode)    7940 + i
 *   lk-jwt (auth service)                   7980 + i    `http://localhost:7980+i`, what the well-known `rtc_foci` points at
 * LiveKit's signalling binds 127.0.0.1; its media ports advertise this machine's interface address (`livekitNodeIp`,
 * no external IP probing: offline-safe, CI-safe; Chromium cannot pair a loopback candidate).
 *
 * The binary is fetched once into homeserver/.rtc/ (git-ignored) from the pinned GitHub release; LIVEKIT_SERVER_BIN
 * points at an existing binary instead (a Homebrew/apt install, or a cache in CI). Nothing here needs Docker.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HS_DIR, ROOT, sleep } from './hs-config.mjs';
import { primaryLanIPv4 } from './lan.mjs';

export const LIVEKIT_VERSION = '1.13.10';
export const RTC_DIR = path.join(HS_DIR, '.rtc');
/** The API key pair every local LiveKit + jwt pair shares (dev only; the homelab has its own). */
export const LIVEKIT_API_KEY = 'devkey';
export const LIVEKIT_API_SECRET = 'codec-local-livekit-secret-0123456789abcdef';
export const BASE_LK_PORT = 7880;
export const BASE_LK_TCP_PORT = 7920;
export const BASE_LK_UDP_PORT = 7940;
export const BASE_JWT_PORT = 7980;

const JWT_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lk-jwt.mjs');

export function rtcPortsFor(i) {
  return { lk: BASE_LK_PORT + i, lkTcp: BASE_LK_TCP_PORT + i, lkUdp: BASE_LK_UDP_PORT + i, jwt: BASE_JWT_PORT + i };
}

export const livekitUrlFor = (i) => `ws://localhost:${rtcPortsFor(i).lk}`;
export const jwtUrlFor = (i) => `http://localhost:${rtcPortsFor(i).jwt}`;

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------

function releaseAsset() {
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!arch) throw new Error(`no LiveKit release for CPU architecture ${process.arch}`);
  switch (process.platform) {
    case 'linux':
      return { file: `livekit_${LIVEKIT_VERSION}_linux_${arch}.tar.gz`, bin: 'livekit-server' };
    case 'darwin':
      return { file: `livekit_${LIVEKIT_VERSION}_darwin_${arch}.tar.gz`, bin: 'livekit-server' };
    case 'win32':
      return { file: `livekit_${LIVEKIT_VERSION}_windows_${arch}.zip`, bin: 'livekit-server.exe' };
    default:
      throw new Error(`no LiveKit release for ${process.platform}`);
  }
}

export function livekitBinaryPath() {
  if (process.env.LIVEKIT_SERVER_BIN) return process.env.LIVEKIT_SERVER_BIN;
  return path.join(RTC_DIR, releaseAsset().bin);
}

function binaryVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout + r.stderr).trim();
}

/** null when a usable LiveKit binary exists (or can be fetched by `ensureLivekitBinary`), else why not. */
export function livekitBinaryProblem() {
  const bin = livekitBinaryPath();
  if (existsSync(bin)) return binaryVersion(bin) ? null : `${bin} does not run (\`--version\` failed)`;
  if (process.env.LIVEKIT_SERVER_BIN) return `LIVEKIT_SERVER_BIN=${bin} does not exist`;
  return null; // not downloaded yet; `up` fetches it
}

/** Download the pinned release into homeserver/.rtc when missing. Resolves with the binary path. */
export async function ensureLivekitBinary({ quiet = false } = {}) {
  const bin = livekitBinaryPath();
  if (existsSync(bin)) {
    const v = binaryVersion(bin);
    if (v) return bin;
    throw new Error(`${bin} exists but does not run; delete it (or set LIVEKIT_SERVER_BIN) and retry`);
  }
  if (process.env.LIVEKIT_SERVER_BIN) throw new Error(`LIVEKIT_SERVER_BIN=${bin} does not exist`);
  const { file } = releaseAsset();
  const url = process.env.LIVEKIT_DOWNLOAD_URL ?? `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/${file}`;
  mkdirSync(RTC_DIR, { recursive: true });
  const archive = path.join(RTC_DIR, file);
  if (!quiet) console.log(`[rtc] fetching LiveKit ${LIVEKIT_VERSION} (${url}) ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`downloading ${url} failed: HTTP ${res.status}`);
  writeFileSync(archive, new Uint8Array(await res.arrayBuffer()));
  // `tar` handles both .tar.gz and .zip on Linux/macOS/Windows 10+ (bsdtar). Extract into a staging dir, keep the binary.
  const staging = path.join(RTC_DIR, 'extract');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const r = spawnSync('tar', ['-xf', archive, '-C', staging], { encoding: 'utf8', timeout: 120_000 });
  if (r.error || r.status !== 0) throw new Error(`extracting ${archive} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  const extracted = path.join(staging, path.basename(bin));
  if (!existsSync(extracted)) throw new Error(`${file} did not contain ${path.basename(bin)}`);
  renameSync(extracted, bin);
  rmSync(staging, { recursive: true, force: true });
  rmSync(archive, { force: true });
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  const v = binaryVersion(bin);
  if (!v) throw new Error(`${bin} was downloaded but does not run`);
  if (!quiet) console.log(`[rtc] ${v} -> ${path.relative(ROOT, bin)}`);
  return bin;
}

// ---------------------------------------------------------------------------
// Config + processes
// ---------------------------------------------------------------------------

/**
 * The address LiveKit advertises in its ICE candidates. Chromium never pairs a remote loopback candidate (it does
 * not enumerate `lo` without `--allow-loopback-in-peer-connection`), so `127.0.0.1` makes every `room.connect` die
 * with "could not establish pc connection"; the machine's own interface address works in a plain browser. Signalling
 * (`port`) stays bound to 127.0.0.1, so nothing on the LAN can join; only the media ports answer there.
 * `LIVEKIT_NODE_IP` overrides (offline laptops: `127.0.0.1` + the Chromium flag).
 */
export function livekitNodeIp() {
  return process.env.LIVEKIT_NODE_IP ?? primaryLanIPv4() ?? '127.0.0.1';
}

export function renderLivekitConfig(ports, nodeIp = livekitNodeIp()) {
  return [
    `# generated by scripts/lib/rtc-stack.mjs (LiveKit ${LIVEKIT_VERSION}); local dev / test only`,
    `port: ${ports.lk}`,
    `bind_addresses: ["127.0.0.1"]`,
    `rtc:`,
    `  tcp_port: ${ports.lkTcp}`,
    `  udp_port: ${ports.lkUdp}`,
    `  use_external_ip: false`,
    `  node_ip: ${nodeIp}`,
    `keys:`,
    `  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}`,
    `room:`,
    `  auto_create: true`,
    `  empty_timeout: 60`,
    `logging:`,
    `  level: info`,
    `  json: false`,
    '',
  ].join('\n');
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function stopPid(pid, timeoutMs = 10_000) {
  if (!processAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const start = Date.now();
  while (processAlive(pid) && Date.now() - start < timeoutMs) await sleep(100);
  if (processAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    await sleep(200);
  }
  return true;
}

async function answering(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, label, { timeoutMs = 30_000, alive, logPath } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (alive && !alive()) throw new Error(`${label} exited; last log lines:\n${tail(logPath)}`);
    if (await answering(url)) return;
    await sleep(200);
  }
  throw new Error(`${label} did not answer on ${url} within ${timeoutMs / 1000}s; last log lines:\n${tail(logPath)}`);
}

function tail(file, lines = 20) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/**
 * Start LiveKit + the auth service for instance `index` next to the homeserver on `hsUrl`. `dir` receives the config
 * and the two log files. Resolves with `{ index, ports, livekitPid, jwtPid, livekitUrl, jwtUrl, dir }` once both answer.
 */
export async function startRtcStack({ index, dir, hsUrl }) {
  const ports = rtcPortsFor(index);
  const bin = await ensureLivekitBinary({ quiet: true });
  mkdirSync(dir, { recursive: true });
  for (const [port, what] of [
    [ports.lk, 'LiveKit'],
    [ports.jwt, 'the LiveKit auth service'],
  ]) {
    if (await answering(`http://localhost:${port}/`)) throw new Error(`port ${port} is already serving something (${what} of another stack?); stop it or use another instance index.`);
  }
  const configPath = path.join(dir, 'livekit.yaml');
  writeFileSync(configPath, renderLivekitConfig(ports));

  const lkLog = path.join(dir, 'livekit.log');
  const lkFd = openSync(lkLog, 'a');
  const lk = spawn(bin, ['--config', configPath], { detached: true, stdio: ['ignore', lkFd, lkFd], windowsHide: true });
  closeSync(lkFd);
  lk.unref();

  const jwtLog = path.join(dir, 'lk-jwt.log');
  const jwtFd = openSync(jwtLog, 'a');
  const jwt = spawn(process.execPath, [JWT_SCRIPT], {
    detached: true,
    stdio: ['ignore', jwtFd, jwtFd],
    windowsHide: true,
    cwd: ROOT,
    env: {
      ...process.env,
      LIVEKIT_URL: livekitUrlFor(index),
      LIVEKIT_KEY: LIVEKIT_API_KEY,
      LIVEKIT_SECRET: LIVEKIT_API_SECRET,
      LIVEKIT_JWT_BIND: `127.0.0.1:${ports.jwt}`,
      LIVEKIT_HOMESERVER_URL: hsUrl,
      LIVEKIT_FULL_ACCESS_HOMESERVERS: 'localhost',
    },
  });
  closeSync(jwtFd);
  jwt.unref();

  const handle = { index, ports, livekitPid: lk.pid, jwtPid: jwt.pid, livekitUrl: livekitUrlFor(index), jwtUrl: jwtUrlFor(index), dir };
  try {
    await waitFor(`http://localhost:${ports.lk}/`, 'LiveKit', { alive: () => processAlive(lk.pid), logPath: lkLog });
    await waitFor(`${handle.jwtUrl}/healthz`, 'the LiveKit auth service', { alive: () => processAlive(jwt.pid), logPath: jwtLog });
  } catch (e) {
    await stopRtcStack(handle);
    throw e;
  }
  return handle;
}

export async function stopRtcStack(handle) {
  if (!handle) return false;
  const a = await stopPid(handle.jwtPid);
  const b = await stopPid(handle.livekitPid);
  return a || b;
}

export function rtcStackAlive(handle) {
  return !!handle && processAlive(handle.livekitPid) && processAlive(handle.jwtPid);
}

export async function rtcStackStatus(handle) {
  if (!handle) return 'not running';
  const lk = processAlive(handle.livekitPid) ? ((await answering(`http://localhost:${handle.ports.lk}/`)) ? 'answering' : 'alive, not answering') : 'DEAD';
  const jwt = processAlive(handle.jwtPid) ? ((await answering(`${handle.jwtUrl}/healthz`)) ? 'answering' : 'alive, not answering') : 'DEAD';
  return `livekit :${handle.ports.lk} ${lk} (pid ${handle.livekitPid}); lk-jwt :${handle.ports.jwt} ${jwt} (pid ${handle.jwtPid})`;
}

/** Hostname a phone on the LAN would use is irrelevant here: the local stack is loopback-only by design. */
export const RTC_LOCAL_ONLY_NOTE = `the local call stack's signalling listens on 127.0.0.1 only (LAN phones need the homelab stack); host ${os.hostname()}`;
