/**
 * Pool backend: Synapse in Docker, one container per instance (JC's Mac/PC; any Docker-capable CI runner).
 * Implements the contract documented at the top of scripts/lib/hs-native.mjs.
 *
 * Each instance dir (homeserver.yaml, log.config, homeserver.db, media_store, secrets/, signing key) is bind-mounted at
 * /data, so the rendered config keeps its `/data/...` paths (dataRoot). The container `matrix-poc-pool-<i>` listens on
 * the instance port inside the container (bound to 0.0.0.0 there, so the port mapping reaches it) and publishes the same
 * port on the host. The flags mirror scripts/hs.mjs / homeserver/docker-compose.yml: SYNAPSE_SERVER_NAME,
 * SYNAPSE_REPORT_STATS, and UID/GID = the host user on Linux/macOS so Synapse can read the 0600 secrets (Windows keeps
 * the image default 991). `docker logs -f` streams the container output into the per-instance log file.
 *
 * Environment: SYNAPSE_IMAGE (default ghcr.io/element-hq/synapse:latest, same as scripts/hs.mjs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { sleep } from './hs-config.mjs';

const IMAGE = process.env.SYNAPSE_IMAGE ?? 'ghcr.io/element-hq/synapse:latest';
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';
const HOST_IDS = process.platform === 'win32' ? null : { uid: String(process.getuid()), gid: String(process.getgid()) };
const NAME_PREFIX = 'matrix-poc-pool-';

let cachedVersion;

function docker(args, { timeout = 60_000 } = {}) {
  return spawnSync(DOCKER, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
}

function errText(r) {
  return (r.stderr || r.stdout || r.error?.message || '').trim();
}

function containerName(port, dir) {
  // The instance dir is homeserver/data/pool/hs-<i> or .../template; name the container after it.
  const leaf = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return NAME_PREFIX + (leaf.startsWith('hs-') ? leaf.slice(3) : leaf || String(port));
}

function running(container) {
  if (!container) return false;
  const r = docker(['inspect', '-f', '{{.State.Running}}', container], { timeout: 20_000 });
  return !r.error && r.status === 0 && r.stdout.trim() === 'true';
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export const dockerBackend = {
  name: 'docker',
  /** Inside the container Synapse must listen on all interfaces, or the published port cannot reach it. */
  bindAddresses: ['0.0.0.0'],

  available({ timeoutMs = 20_000 } = {}) {
    const r = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: timeoutMs });
    if (r.error || r.status !== 0 || !r.stdout.trim() || /error/i.test(r.stdout)) {
      return `\`${DOCKER} info\` failed (is Docker running?): ${errText(r).split('\n').pop()}`;
    }
    return null;
  },

  version() {
    if (cachedVersion === undefined) {
      // Pulls the image on first use. The version is part of the snapshot cache key, so a new :latest re-seeds.
      const r = docker(['run', '--rm', '--entrypoint', 'python3', IMAGE, '-c', 'import synapse; print(synapse.__version__)'], { timeout: 600_000 });
      if (r.error || r.status !== 0) throw new Error(`could not read the Synapse version from ${IMAGE}: ${errText(r).split('\n').slice(-5).join('\n')}`);
      cachedVersion = r.stdout.trim().split('\n').pop();
    }
    return `synapse ${cachedVersion} (docker ${IMAGE})`;
  },

  dataRoot() {
    return '/data';
  },

  start({ dir, port, configPath, logPath }) {
    const container = containerName(port, dir);
    // A crashed run may have left the container behind; it would hold the name (and maybe the port).
    docker(['rm', '-f', container], { timeout: 60_000 });
    const r = docker(
      [
        'run', '-d',
        '--name', container,
        '--no-healthcheck', // the image's HEALTHCHECK probes :8008, which is wrong for every instance but the first
        '-p', `${port}:${port}`,
        '-v', `${dir}:/data`,
        '-e', 'SYNAPSE_SERVER_NAME=localhost',
        '-e', 'SYNAPSE_REPORT_STATS=no',
        '-e', `SYNAPSE_CONFIG_PATH=/data/${configPath.split(/[\\/]/).pop()}`,
        ...(HOST_IDS ? ['-e', `UID=${HOST_IDS.uid}`, '-e', `GID=${HOST_IDS.gid}`] : []),
        IMAGE,
      ],
      { timeout: 600_000 },
    );
    if (r.error || r.status !== 0) throw new Error(`docker run ${container} failed: ${errText(r).split('\n').slice(-5).join('\n')}`);

    // Capture the container's stdout/stderr (log.config logs to the console) in the instance log file. The follower
    // exits on its own when the container is removed.
    const fd = openSync(logPath, 'a');
    const follower = spawn(DOCKER, ['logs', '-f', container], { detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    follower.unref();
    return { container, logPid: follower.pid };
  },

  alive({ container }) {
    return running(container);
  },

  async stop({ container, logPid }, { timeoutMs = 15_000 } = {}) {
    if (!container) return false;
    const wasRunning = running(container);
    // Graceful stop first (SIGTERM: Synapse closes the SQLite db cleanly, which matters for the snapshot template),
    // then remove the container so the name and port are free.
    if (wasRunning) docker(['stop', '-t', String(Math.ceil(timeoutMs / 1000)), container], { timeout: timeoutMs + 30_000 });
    docker(['rm', '-f', container], { timeout: 60_000 });
    if (pidAlive(logPid)) {
      await sleep(200);
      try {
        process.kill(logPid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    return wasRunning;
  },
};
