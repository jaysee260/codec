/**
 * Pool backend: Synapse run natively from a Python venv (this cloud container, Linux CI).
 *
 * Backend contract (see scripts/hs-pool.mjs; a Docker backend implements the same shape):
 *   name                      'native' | 'docker'
 *   available()               string | null  - null when usable, else why not
 *   version()                 string         - Synapse version, part of the snapshot cache key
 *   dataRoot(dir)             string         - the path prefix the instance config uses for `/data/...`
 *   start({ dir, port, configPath, logPath }) -> { pid }   detached process; stdout+stderr -> logPath
 *   stop({ pid })             boolean        - true when it was running and is now gone
 *   alive({ pid })            boolean
 *
 * Environment: SYNAPSE_PYTHON (default homeserver/.venv/bin/python when present, else `python3` on PATH).
 * Setup: python3 -m venv homeserver/.venv && homeserver/.venv/bin/pip install 'matrix-synapse[url-preview]'
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './hs-config.mjs';

const DEFAULT_VENV_PYTHON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../homeserver/.venv/bin/python');

export function pythonBin() {
  if (process.env.SYNAPSE_PYTHON) return process.env.SYNAPSE_PYTHON;
  if (existsSync(DEFAULT_VENV_PYTHON)) return DEFAULT_VENV_PYTHON;
  return 'python3';
}

let cachedVersion;

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export const native = {
  name: 'native',

  available() {
    const py = pythonBin();
    const r = spawnSync(py, ['-c', 'import synapse; print(synapse.__version__)'], { encoding: 'utf8', timeout: 30_000 });
    if (r.error || r.status !== 0) {
      return `${py} cannot import synapse (set SYNAPSE_PYTHON to a venv with matrix-synapse installed): ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`;
    }
    cachedVersion = r.stdout.trim();
    return null;
  },

  version() {
    if (cachedVersion === undefined) {
      const why = this.available();
      if (why) throw new Error(why);
    }
    return `synapse ${cachedVersion} (${pythonBin()})`;
  },

  dataRoot(dir) {
    return dir;
  },

  start({ configPath, logPath }) {
    // `--generate-missing-and-run` is Synapse's default: it writes the signing key on the first start of a
    // template and simply runs on a restored clone. stdout/stderr go to the per-instance log file.
    const fd = openSync(logPath, 'a');
    const child = spawn(pythonBin(), ['-m', 'synapse.app.homeserver', '-c', configPath], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    child.unref();
    return { pid: child.pid };
  },

  alive({ pid }) {
    return processAlive(pid);
  },

  async stop({ pid }, { timeoutMs = 15_000 } = {}) {
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
  },
};
