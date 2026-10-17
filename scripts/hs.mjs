#!/usr/bin/env node
/**
 * Homeserver lifecycle wrapper. Two backends, same commands:
 *
 *   docker (preferred)  homeserver/docker-compose.yml, used when `docker info` succeeds
 *   wsl (fallback)      homeserver/wsl/hs.sh (Synapse installed natively in a WSL1 distro), used when
 *                       Docker is unavailable, e.g. machines without hardware virtualization
 *
 *   node scripts/hs.mjs up      start synapse (docker: also generates the signing key if missing), wait until it answers
 *   node scripts/hs.mjs down    stop it (data kept)
 *   node scripts/hs.mjs reset   wipe database + media, start again (config kept)
 *   node scripts/hs.mjs logs    show synapse logs
 *   node scripts/hs.mjs status  which backend would be used + is the server answering
 *
 * Environment: HS_URL (default http://localhost:8008), HS_BACKEND=docker|wsl to force one,
 *              SYNAPSE_IMAGE (default ghcr.io/element-hq/synapse:latest)
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HS_DIR = path.join(ROOT, 'homeserver');
const DATA_DIR = path.join(HS_DIR, 'data');
const CONFIG = path.join(HS_DIR, 'homeserver.yaml');
const SIGNING_KEY = path.join(DATA_DIR, 'localhost.signing.key');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');
// homeserver.yaml points at these via *_path so no secret is ever committed (see homeserver/README.md).
const SECRET_FILES = ['registration_shared_secret', 'macaroon_secret_key', 'form_secret'];
const WSL_SCRIPT = path.join(HS_DIR, 'wsl', 'hs.sh');
const KEEP_ON_RESET = new Set(['.gitkeep', 'secrets']);
const HS_URL = (process.env.HS_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
const IMAGE = process.env.SYNAPSE_IMAGE ?? 'ghcr.io/element-hq/synapse:latest';
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';

const MARKER = '# --- matrix-poc overrides ---';
const OVERRIDES = `
${MARKER}
# POC-only settings: open registration, no rate limits, presence on, unauthenticated media (so <img src> works).
public_baseurl: ${HS_URL}/
serve_server_wellknown: false
suppress_key_server_warning: true
enable_registration: true
enable_registration_without_verification: true
allow_public_rooms_without_auth: true
enable_authenticated_media: false
url_preview_enabled: true
url_preview_ip_range_blacklist:
  - "127.0.0.0/8"
  - "10.0.0.0/8"
  - "172.16.0.0/12"
  - "192.168.0.0/16"
  - "100.64.0.0/10"
  - "192.0.0.0/24"
  - "169.254.0.0/16"
  - "192.88.99.0/24"
  - "198.18.0.0/15"
  - "192.0.2.0/24"
  - "198.51.100.0/24"
  - "203.0.113.0/24"
  - "224.0.0.0/4"
  - "::1/128"
  - "fe80::/10"
  - "fc00::/7"
  - "2001:db8::/32"
  - "ff00::/8"
  - "fec0::/10"
url_preview_accept_language:
  - en-US
  - en
max_spider_size: 10M
presence:
  enabled: true
rc_message:
  per_second: 1000
  burst_count: 1000
rc_registration:
  per_second: 1000
  burst_count: 1000
rc_login:
  address:
    per_second: 1000
    burst_count: 1000
  account:
    per_second: 1000
    burst_count: 1000
  failed_attempts:
    per_second: 1000
    burst_count: 1000
rc_joins:
  local:
    per_second: 1000
    burst_count: 1000
  remote:
    per_second: 1000
    burst_count: 1000
rc_joins_per_room:
  per_second: 1000
  burst_count: 1000
rc_invites:
  per_room:
    per_second: 1000
    burst_count: 1000
  per_user:
    per_second: 1000
    burst_count: 1000
  per_issuer:
    per_second: 1000
    burst_count: 1000
rc_presence:
  per_user:
    per_second: 1000
    burst_count: 1000
rc_media_create:
  per_second: 1000
  burst_count: 1000
rc_admin_redaction:
  per_second: 1000
  burst_count: 1000
# Room creation has its own limiter (default: 10 rooms, then one per minute). The E2E suite and the
# demo create channels/spaces/DMs as alice, so it must be relaxed too or createRoom starts returning 429.
rc_room_creation:
  per_second: 1000
  burst_count: 1000
experimental_features:
  # Simplified Sliding Sync (MSC4186). On by default in current Synapse; the flag is a no-op there.
  msc3575_enabled: true
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, { capture = false, check = true, cwd = HS_DIR, timeout } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', timeout });
  if (r.error) throw r.error;
  if (check && r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}${capture ? `\n${r.stderr}` : ''}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

function dockerWorks() {
  const r = spawnSync(DOCKER, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20_000 });
  return !r.error && r.status === 0 && !!r.stdout.trim() && !/error/i.test(r.stdout);
}

function pickBackend() {
  const forced = process.env.HS_BACKEND;
  if (forced === 'docker' || forced === 'wsl') return forced;
  if (dockerWorks()) return 'docker';
  if (existsSync(WSL_SCRIPT)) {
    console.log('Docker is not available; using the WSL fallback (homeserver/wsl/hs.sh).');
    return 'wsl';
  }
  throw new Error(
    'Docker engine is not responding and homeserver/wsl/hs.sh is missing. Start Docker Desktop (needs virtualization enabled in firmware) or set up the WSL fallback (see homeserver/README.md).',
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function ensureConfigPatched() {
  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} is missing; restore it from git.`);
  const yaml = readFileSync(CONFIG, 'utf8');
  if (!yaml.includes(MARKER)) {
    writeFileSync(CONFIG, yaml.trimEnd() + '\n' + OVERRIDES);
    console.log('Applied matrix-poc overrides to homeserver/homeserver.yaml');
  }
}

async function waitForHomeserver(timeoutMs = 120_000, onTimeout) {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${HS_URL}/_matrix/client/versions`);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e.message;
    }
    await sleep(1500);
  }
  onTimeout?.();
  throw new Error(`Synapse did not answer on ${HS_URL} within ${timeoutMs / 1000}s (${lastError}).`);
}

function reportUp(versions) {
  console.log(`Synapse is up on ${HS_URL}. Spec versions: ${versions.versions.slice(-3).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Docker backend
// ---------------------------------------------------------------------------

const docker = {
  ensureSecrets() {
    mkdirSync(SECRETS_DIR, { recursive: true });
    for (const name of SECRET_FILES) {
      const file = path.join(SECRETS_DIR, name);
      if (existsSync(file)) continue;
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
      console.log(`Generated data/secrets/${name}`);
    }
  },
  ensureSigningKey() {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(SIGNING_KEY)) return;
    console.log('Generating data/localhost.signing.key ...');
    sh(DOCKER, [
      'run', '--rm',
      '-v', `${DATA_DIR}:/data`,
      '-v', `${CONFIG}:/data/homeserver.yaml`,
      '-v', `${path.join(HS_DIR, 'localhost.log.config')}:/data/localhost.log.config`,
      '-e', 'SYNAPSE_SERVER_NAME=localhost',
      '-e', 'SYNAPSE_REPORT_STATS=no',
      IMAGE, 'generate',
    ]);
  },
  async up() {
    ensureConfigPatched();
    this.ensureSecrets();
    this.ensureSigningKey();
    sh(DOCKER, ['compose', 'up', '-d']);
    console.log(`Waiting for Synapse on ${HS_URL} ...`);
    reportUp(await waitForHomeserver(120_000, () => sh(DOCKER, ['compose', 'logs', '--tail', '40', 'synapse'], { check: false })));
  },
  down() {
    sh(DOCKER, ['compose', 'down'], { check: false });
  },
  async reset() {
    this.down();
    if (existsSync(DATA_DIR)) {
      for (const entry of readdirSync(DATA_DIR)) {
        if (KEEP_ON_RESET.has(entry)) continue;
        rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
      }
      console.log('Wiped homeserver/data');
    }
    await this.up();
  },
  logs() {
    sh(DOCKER, ['compose', 'logs', '-f', 'synapse'], { check: false });
  },
};

// ---------------------------------------------------------------------------
// WSL backend (delegates to homeserver/wsl/hs.sh)
// ---------------------------------------------------------------------------

function wslRun(cmd) {
  sh('bash', [WSL_SCRIPT, cmd], { cwd: ROOT });
}

const wsl = {
  async up() {
    wslRun('start');
    console.log(`Waiting for Synapse on ${HS_URL} ...`);
    reportUp(await waitForHomeserver(120_000, () => wslRun('logs')));
  },
  down() {
    wslRun('stop');
  },
  async reset() {
    wslRun('reset');
    console.log(`Waiting for Synapse on ${HS_URL} ...`);
    reportUp(await waitForHomeserver(120_000, () => wslRun('logs')));
  },
  logs() {
    wslRun('logs');
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const backend = pickBackend();
    console.log(`backend: ${backend}`);
    try {
      const versions = await (await fetch(`${HS_URL}/_matrix/client/versions`)).json();
      reportUp(versions);
    } catch {
      console.log(`Synapse is NOT answering on ${HS_URL}`);
    }
    return;
  }
  if (!['up', 'down', 'reset', 'logs'].includes(cmd)) {
    console.error('usage: node scripts/hs.mjs <up|down|reset|logs|status>');
    process.exit(2);
  }
  const backend = pickBackend() === 'docker' ? docker : wsl;
  await backend[cmd]();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
