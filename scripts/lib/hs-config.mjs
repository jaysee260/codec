/**
 * Shared homeserver config helpers for `scripts/hs.mjs` (the single dev homeserver) and `scripts/hs-pool.mjs`
 * (N seeded clones for parallel e2e runs).
 *
 * The committed `homeserver/homeserver.yaml` is the single source of truth: it carries the "matrix-poc overrides"
 * block (open registration, no rate limits, `login_via_existing_session` for auth-media.spec, ...). The pool never
 * invents a config; `renderInstanceConfig` rewrites only the per-instance parts (port, data paths, public_baseurl).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HS_DIR = path.join(ROOT, 'homeserver');
export const DATA_DIR = path.join(HS_DIR, 'data');
export const CONFIG = path.join(HS_DIR, 'homeserver.yaml');
export const LOG_CONFIG = path.join(HS_DIR, 'localhost.log.config');
// homeserver.yaml points at these via *_path so no secret is ever committed (see homeserver/README.md).
export const SECRET_FILES = ['registration_shared_secret', 'macaroon_secret_key', 'form_secret'];
export const MARKER = '# --- matrix-poc overrides ---';
/** The port/URL the single dev homeserver and worker 0 of the pool use. */
export const DEFAULT_HS_PORT = 8008;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes the three Synapse secret files (64 hex chars each) into `<dataDir>/secrets` when missing. */
export function ensureSecrets(dataDir = DATA_DIR, { quiet = false } = {}) {
  const secretsDir = path.join(dataDir, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  for (const name of SECRET_FILES) {
    const file = path.join(secretsDir, name);
    if (existsSync(file)) continue;
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    if (!quiet) console.log(`Generated ${path.relative(ROOT, file)}`);
  }
}

/** Polls `GET /_matrix/client/versions` until it answers; resolves with the versions body. */
export async function waitForHomeserver(hsUrl, timeoutMs = 120_000, { onTimeout, interval = 500, abort } = {}) {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    if (abort?.()) throw new Error(`Synapse on ${hsUrl} exited before it answered (${abort()}).`);
    try {
      const res = await fetch(`${hsUrl}/_matrix/client/versions`);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e.message;
    }
    await sleep(interval);
  }
  onTimeout?.();
  throw new Error(`Synapse did not answer on ${hsUrl} within ${timeoutMs / 1000}s (${lastError}).`);
}

/** The committed homeserver.yaml, verified to carry its overrides block (read-only; `scripts/hs.mjs` is what appends it). */
export function readBaseConfig() {
  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} is missing; restore it from git.`);
  const yaml = readFileSync(CONFIG, 'utf8');
  if (!yaml.includes(MARKER)) {
    throw new Error(`${CONFIG} lacks the "${MARKER}" block (open registration, no rate limits, login_via_existing_session). Run \`npm run hs:up\` once to append it, or restore the file from git.`);
  }
  return yaml;
}

/**
 * Renders a per-instance homeserver.yaml from the committed one. Only these parts change:
 *  - every `/data/...` path -> `<dataRoot>/...` (native: the instance dir; docker: keep `/data` and mount the dir);
 *  - the listener port (+ `bind_addresses: ['127.0.0.1']`, binding `::` fails in some containers);
 *  - `public_baseurl` -> the instance URL;
 *  - `log_config` -> `<dataRoot>/<logConfigName>` (the caller writes that file; see `renderLogConfig`).
 */
export function renderInstanceConfig({ port, dataRoot, hsUrl = `http://localhost:${port}`, logConfigName = 'log.config', bindAddresses = ['127.0.0.1'] }) {
  let yaml = readBaseConfig();
  const root = dataRoot.replace(/\/+$/, '');
  yaml = yaml.replace(/(["']?)\/data\//g, `$1${root}/`);
  yaml = yaml.replace(/^(\s*)-\s*port:\s*\d+\s*$/m, (_, indent) => `${indent}- port: ${port}\n${indent}  bind_addresses: [${bindAddresses.map((a) => `'${a}'`).join(', ')}]`);
  yaml = yaml.replace(/^public_baseurl:.*$/m, `public_baseurl: ${hsUrl}/`);
  yaml = yaml.replace(/^log_config:.*$/m, `log_config: "${root}/${logConfigName}"`);
  if (!yaml.includes(`- port: ${port}`)) throw new Error('renderInstanceConfig: could not find the listener port in homeserver.yaml');
  return yaml;
}

/** The committed log config (console/stdout only); the caller captures the process stdout per instance. */
export function renderLogConfig() {
  return readFileSync(LOG_CONFIG, 'utf8');
}
