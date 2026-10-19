#!/usr/bin/env node
/**
 * Phase 7: the local call stack for the single dev homeserver (LiveKit SFU + the LiveKit auth service, see
 * scripts/lib/rtc-stack.mjs). `npm run hs:up` runs `up` after Synapse is up; `npm run hs:down` runs `down` first.
 *
 *   node scripts/rtc.mjs fetch     download the pinned LiveKit release into homeserver/.rtc (no-op when present)
 *   node scripts/rtc.mjs up        start LiveKit on ws://localhost:7880 + lk-jwt on http://localhost:7980 for the
 *                                  homeserver on HS_URL (default http://localhost:8008); reuses a running stack
 *   node scripts/rtc.mjs down      stop them (never fails: safe in `hs:down` chains)
 *   node scripts/rtc.mjs status    what is running / answering
 *
 * Environment: HS_URL (the Synapse lk-jwt verifies OpenID tokens against), RTC_INDEX (instance index, default 0: use
 * 1.. to run a second stack by hand without clashing with the pool), LIVEKIT_SERVER_BIN (skip the download).
 * State: homeserver/.rtc/state-<index>.json (pids, ports); config + logs under homeserver/.rtc/stack-<index>/.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVEKIT_VERSION, RTC_DIR, ensureLivekitBinary, livekitBinaryPath, livekitBinaryProblem, rtcStackAlive, rtcStackStatus, startRtcStack, stopRtcStack } from './lib/rtc-stack.mjs';

const INDEX = Number(process.env.RTC_INDEX ?? 0);
const HS_URL = (process.env.HS_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
const STATE_FILE = path.join(RTC_DIR, `state-${INDEX}.json`);
const STACK_DIR = path.join(RTC_DIR, `stack-${INDEX}`);

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function up() {
  const previous = readState();
  if (previous && rtcStackAlive(previous)) {
    console.log(`[rtc] call stack ${INDEX} already running: ${await rtcStackStatus(previous)}`);
    return previous;
  }
  if (previous) await stopRtcStack(previous);
  mkdirSync(STACK_DIR, { recursive: true });
  const handle = await startRtcStack({ index: INDEX, dir: STACK_DIR, hsUrl: HS_URL });
  writeFileSync(STATE_FILE, JSON.stringify({ ...handle, hsUrl: HS_URL, startedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`[rtc] LiveKit ${handle.livekitUrl} + auth service ${handle.jwtUrl} up for ${HS_URL} (logs: ${path.relative(process.cwd(), STACK_DIR)})`);
  return handle;
}

export async function down() {
  const state = readState();
  if (!state) {
    console.log('[rtc] nothing to stop');
    return;
  }
  const stopped = await stopRtcStack(state);
  rmSync(STATE_FILE, { force: true });
  console.log(stopped ? `[rtc] stopped call stack ${INDEX}` : `[rtc] call stack ${INDEX} was not running`);
}

async function status() {
  const problem = livekitBinaryProblem();
  console.log(`binary: ${existsSync(livekitBinaryPath()) ? `${path.relative(process.cwd(), livekitBinaryPath())} (LiveKit ${LIVEKIT_VERSION})` : '(not fetched: npm run rtc:fetch)'}${problem ? ` - ${problem}` : ''}`);
  console.log(`stack ${INDEX}: ${await rtcStackStatus(readState())}`);
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'fetch':
      await ensureLivekitBinary();
      return;
    case 'up':
      await up();
      return;
    case 'down':
      await down().catch((e) => console.warn(`[rtc] ${e.message}`));
      return;
    case 'status':
      await status();
      return;
    default:
      console.error('usage: node scripts/rtc.mjs <fetch|up|down|status>');
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[rtc] ${e.message ?? e}`);
    process.exit(1);
  });
}
