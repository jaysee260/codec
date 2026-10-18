/**
 * Playwright globalSetup: bring up one freshly restored, seeded Synapse per worker (scripts/hs-pool.mjs `up`) and
 * stop them again when the run ends (the returned teardown runs `down`). See e2e/fixtures/pool.ts for the port plan.
 *
 *  - `E2E_REUSE_SERVERS=1` skips all of it and uses whatever is already listening (dev loops; also the escape hatch on
 *    machines without a pool backend, e.g. the WSL1 setup, together with `E2E_WORKERS=1`).
 *  - `E2E_WORKERS=1` with a homeserver already answering on 8008 reuses it, exactly like before the pool existed.
 *  - Windows with only the WSL1 homeserver (no venv, no Docker): fixtures/pool.ts drops to 1 worker and sets
 *    E2E_POOL_FALLBACK; the server on 8008 is used as is (never started or reset here).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { baseUrlFor, hsUrlFor, poolSize } from './fixtures/pool.ts';

async function answering(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/_matrix/client/versions`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function pool(...args: string[]): void {
  const r = spawnSync(process.execPath, ['scripts/hs-pool.mjs', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`scripts/hs-pool.mjs ${args.join(' ')} failed (exit ${r.status})`);
}

export default async function globalSetup(): Promise<(() => void) | void> {
  const n = poolSize();
  const range = (f: (i: number) => string) => (n === 1 ? f(0) : `${f(0)} .. ${f(n - 1)}`);
  console.log(`[e2e] ${n} worker(s): app ${range(baseUrlFor)}, homeserver ${range(hsUrlFor)}`);

  if (process.env.E2E_REUSE_SERVERS) {
    console.log('[e2e] E2E_REUSE_SERVERS is set: not starting or stopping any homeserver.');
    return;
  }
  if (process.env.E2E_POOL_FALLBACK) {
    // WSL1 fallback (see poolSize in fixtures/pool.ts): no pool backend here, use the dev homeserver as before.
    if (await answering(hsUrlFor(0))) return;
    throw new Error(`[e2e] no homeserver answers on ${hsUrlFor(0)}; start it with \`npm run hs:up\` (WSL1 backend) and run again.`);
  }
  if (n === 1 && (await answering(hsUrlFor(0)))) {
    console.log(`[e2e] a homeserver already answers on ${hsUrlFor(0)}; reusing it (set E2E_WORKERS>1 or stop it to run on a fresh snapshot).`);
    return;
  }
  // --replace: a previous run's pool that was not torn down (crash, Ctrl-C) is this run's to restart.
  pool('up', '--workers', String(n), '--replace');
  // Fresh-seed verdicts (fixtures/fresh.ts) are persisted per pool instance only after a restore; drop the last run's.
  const tmp = 'e2e/tmp';
  for (const name of existsSync(tmp) ? readdirSync(tmp) : []) {
    if (/^(fresh-w\d+(-.+)?\.json|ran-w\d+\.jsonl)$/.test(name)) rmSync(`${tmp}/${name}`, { force: true });
  }
  process.env.E2E_POOL_RESTORED = '1';
  return () => pool('down');
}
