#!/usr/bin/env node
/**
 * QA-12 — Android APK build check (AC-C1-1..4, plus AC-C3-1/2 as cheap file checks).
 *
 *   npm run test:android-build                 # build with the LAN URL baked in, then verify
 *   node e2e/android-build.mjs --skip-build    # verify the APK that is already on disk
 *   node e2e/android-build.mjs --hs http://10.0.0.5:8009
 *
 * Deliberately **not** a Playwright project: a browserless `build` project would also run under a
 * bare `npm run test:e2e`, and every run writes a lot and takes minutes. This script is the only
 * thing that triggers a Gradle build in the QA suite.
 *
 * Skips (exit 0, reason printed) when the toolchain is incomplete. The skip condition is
 * `resolveToolchain().problems` from `scripts/toolchain.mjs`, **not** raw `JAVA_HOME`/`ANDROID_HOME`:
 * on this machine both env vars are empty in a fresh shell and the build still works, because the
 * scripts resolve `~/jdk21` and `~/android-sdk` themselves. Reading the env directly would skip a
 * check that can run.
 *
 * Checks:
 *   AC-C1-1  `npm run cap:build:android:lan` exits 0 within 10 min; app-debug.apk exists and is > 1 MB
 *   AC-C1-2  the APK contains assets/public/index.html and some assets/public/assets/*.js holds the baked URL
 *   AC-C1-3  aapt dump permissions lists INTERNET, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS;
 *            aapt dump badging names the package id; the manifest has usesCleartextTraffic="true";
 *            capacitor.config.ts sets androidScheme http / cleartext / allowMixedContent;
 *            package.json pins @capacitor/core at ^7
 *   AC-C1-4  dist/ built with no VITE_HS_URL still contains http://localhost:8008 (desktop unchanged)
 *   AC-C3-1  ios/App/App/Info.plist has NSMicrophoneUsageDescription + NSAllowsArbitraryLoads
 *   AC-C3-2  ios/App/App/public/index.html exists (`npx cap copy ios` ran)
 *
 * Extraction uses `tar -xf` (bsdtar ships with Windows 10+ and reads zips); `unzip -p` is the
 * fallback. `aapt` comes from `$ANDROID_HOME/build-tools/<newest>/`; when it is missing the manifest
 * checks fall back to grepping the *source* AndroidManifest.xml and say so.
 *
 * Side effect to know about: the AC-C1-4 check rebuilds `dist/` **without** `VITE_HS_URL`, so after
 * this script `dist/` holds the localhost default. The APK on disk is unaffected, and
 * `cap:build:android*` always runs `vite build` itself, so nothing can pick up a stale bundle — but
 * never run a bare `npx cap sync` straight after this script expecting the LAN URL.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToolchain } from '../scripts/toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APK = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const TMP = path.join(ROOT, 'e2e', 'results', 'apk');
const WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const results = [];
let skipped = 0;
const pass = (id, name, detail = '') => results.push({ id, name, ok: true, detail });
const fail = (id, name, detail = '') => results.push({ id, name, ok: false, detail });
const skip = (id, name, detail) => {
  skipped += 1;
  results.push({ id, name, ok: null, detail });
};
const check = (id, name, ok, detail = '') => (ok ? pass(id, name, detail) : fail(id, name, detail));

function run(cmd, { cwd = ROOT, env = process.env, timeout } = {}) {
  console.log(`\n> ${cmd}`);
  return spawnSync(cmd, { cwd, env, stdio: 'inherit', shell: true, timeout });
}

function capture(cmd, { cwd = ROOT } = {}) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/* ------------------------------------------------------------------ skip gate */

const tc = resolveToolchain();
if (tc.problems.length && !flag('--skip-build')) {
  console.log('\n[android-build] SKIPPED — the Android toolchain is incomplete:');
  for (const p of tc.problems) console.log(`  - ${p}`);
  console.log('  See docs/MOBILE.md "Toolchain"; `node scripts/toolchain.mjs` shows what was found.');
  console.log('\n[android-build] 0 checks run (skip is not a failure: AC-C1-1 allows it).');
  process.exit(0);
}
if (!tc.problems.length) {
  console.log(`[android-build] JDK ${tc.javaMajor} at ${tc.javaHome}; Android SDK at ${tc.androidHome}`);
}

/* ------------------------------------------------------------------ AC-C1-1 build */

const hsUrl = value('--hs') ?? null;
let bakedUrl = hsUrl;

if (flag('--skip-build')) {
  skip('AC-C1-1', 'cap:build:android:lan exits 0', '--skip-build: verifying the APK already on disk');
} else {
  const started = Date.now();
  const cmd = hsUrl
    ? `node scripts/cap-build-android.mjs --hs ${hsUrl}`
    : 'npm run cap:build:android:lan';
  const r = run(cmd, { timeout: 10 * 60_000 });
  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  check('AC-C1-1', `${cmd} exits 0 within 10 min`, r.status === 0, `exit ${r.status}, ${mins} min`);
  if (r.status !== 0) {
    report();
    process.exit(1);
  }
}

const apkExists = existsSync(APK);
const apkMb = apkExists ? statSync(APK).size / 1024 / 1024 : 0;
check(
  'AC-C1-1',
  'app-debug.apk exists and is > 1 MB',
  apkExists && apkMb > 1,
  apkExists ? `${apkMb.toFixed(1)} MB at android/app/build/outputs/apk/debug/app-debug.apk` : 'missing',
);
if (!apkExists) {
  report();
  process.exit(1);
}

/* ------------------------------------------------------------------ AC-C1-2 extract + baked URL */

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
let extracted = run(`tar -xf "${APK}"`, { cwd: TMP }).status === 0;
if (!extracted) extracted = run(`unzip -oq "${APK}"`, { cwd: TMP }).status === 0;
check('AC-C1-2', 'the APK unpacks (tar -xf / unzip)', extracted, `into ${path.relative(ROOT, TMP)}`);

if (extracted) {
  const webIndex = path.join(TMP, 'assets', 'public', 'index.html');
  check('AC-C1-2', 'assets/public/index.html is inside the APK', existsSync(webIndex));

  const assetsDir = path.join(TMP, 'assets', 'public', 'assets');
  const js = existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : [];
  const blobs = js.map((f) => readFileSync(path.join(assetsDir, f), 'utf8'));
  // The LAN build bakes http://<lan-ip>:8009; without --hs we do not know the IP, so match the port.
  const urlRe = bakedUrl ? new RegExp(bakedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : /http:\/\/[\d.]+:8009/;
  const hit = blobs.find((b) => urlRe.test(b));
  const found = hit ? (hit.match(urlRe) ?? [''])[0] : '';
  if (!bakedUrl && found) bakedUrl = found;
  check(
    'AC-C1-2',
    `a bundled assets/public/assets/*.js contains the baked homeserver URL`,
    !!hit,
    hit ? `found ${found} in one of ${js.length} js chunk(s)` : `no ${urlRe} in ${js.length} js chunk(s)`,
  );
}

/* ------------------------------------------------------------------ AC-C1-3 manifest + config */

const aaptDir = tc.androidHome ? path.join(tc.androidHome, 'build-tools') : '';
const buildToolsVersions = existsSync(aaptDir)
  ? readdirSync(aaptDir).filter((d) => /^\d/.test(d)).sort().reverse()
  : [];
// QA-12 names build-tools/35.0.0; prefer it, else the newest installed.
const preferred = buildToolsVersions.includes('35.0.0') ? '35.0.0' : buildToolsVersions[0];
const aapt = preferred ? path.join(aaptDir, preferred, WIN ? 'aapt.exe' : 'aapt') : '';

const REQUIRED_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
];

if (aapt && existsSync(aapt)) {
  const perms = capture(`"${aapt}" dump permissions "${APK}"`);
  for (const p of REQUIRED_PERMISSIONS) {
    check('AC-C1-3', `aapt dump permissions lists ${p}`, perms.out.includes(p), `build-tools ${preferred}`);
  }

  const badging = capture(`"${aapt}" dump badging "${APK}"`);
  const pkg = (badging.out.match(/package: name='([^']+)'/) ?? [])[1] ?? '';
  check('AC-C1-3', "aapt dump badging names package 'com.acme.matrixpoc'", pkg === 'com.acme.matrixpoc', pkg || 'not found');

  const xmltree = capture(`"${aapt}" dump xmltree "${APK}" AndroidManifest.xml`);
  check(
    'AC-C1-3',
    'the packaged manifest sets usesCleartextTraffic=true',
    /usesCleartextTraffic\(0x[0-9a-f]+\)=\(type 0x12\)0xffffffff/.test(xmltree.out) ||
      /usesCleartextTraffic.*true/i.test(xmltree.out),
    'from the APK, not the source manifest',
  );
} else {
  skip('AC-C1-3', 'aapt permission / badging / manifest dump', `no aapt in ${aaptDir || '(no ANDROID_HOME)'}`);
  // Fall back to the source manifest so the criterion is not silently unchecked.
  const src = readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  for (const p of REQUIRED_PERMISSIONS) {
    check('AC-C1-3', `source AndroidManifest.xml declares ${p} (aapt fallback)`, src.includes(p));
  }
  check('AC-C1-3', 'source AndroidManifest.xml sets usesCleartextTraffic="true" (aapt fallback)', /usesCleartextTraffic="true"/.test(src));
}

const capConfig = readFileSync(path.join(ROOT, 'capacitor.config.ts'), 'utf8');
check('AC-C1-3', "capacitor.config.ts: server.androidScheme 'http'", /androidScheme:\s*'http'/.test(capConfig));
check('AC-C1-3', 'capacitor.config.ts: server.cleartext true', /cleartext:\s*true/.test(capConfig));
check('AC-C1-3', 'capacitor.config.ts: android.allowMixedContent true', /allowMixedContent:\s*true/.test(capConfig));
check('AC-C1-3', "capacitor.config.ts: appId 'com.acme.matrixpoc'", /appId:\s*'com\.acme\.matrixpoc'/.test(capConfig));

const pkgJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const capCore = pkgJson.dependencies?.['@capacitor/core'] ?? '';
check('AC-C1-3', 'package.json pins @capacitor/core at ^7', /^\^?7\./.test(capCore), capCore);

/* ------------------------------------------------------------------ AC-C1-4 web default unchanged */

{
  const env = { ...process.env };
  delete env.VITE_HS_URL;
  const r = run('npx vite build', { env, timeout: 5 * 60_000 });
  check('AC-C1-4', 'npm run build with no VITE_HS_URL exits 0', r.status === 0, `exit ${r.status}`);
  const distAssets = path.join(ROOT, 'dist', 'assets');
  const js = existsSync(distAssets) ? readdirSync(distAssets).filter((f) => f.endsWith('.js')) : [];
  const hit = js.some((f) => readFileSync(path.join(distAssets, f), 'utf8').includes('http://localhost:8008'));
  check('AC-C1-4', 'dist/assets/*.js still contains http://localhost:8008 (desktop unchanged)', hit, `${js.length} js chunk(s)`);
}

/* ------------------------------------------------------------------ AC-C3 iOS file checks */

{
  const plistPath = path.join(ROOT, 'ios', 'App', 'App', 'Info.plist');
  if (existsSync(plistPath)) {
    const plist = readFileSync(plistPath, 'utf8');
    const micDesc = (plist.match(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]*)<\/string>/) ?? [])[1] ?? '';
    check('AC-C3-1', 'Info.plist has a non-empty NSMicrophoneUsageDescription', micDesc.trim().length > 0, micDesc.slice(0, 60));
    check(
      'AC-C3-1',
      'Info.plist has NSAppTransportSecurity > NSAllowsArbitraryLoads true',
      /<key>NSAppTransportSecurity<\/key>[\s\S]*?<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(plist),
    );
  } else {
    fail('AC-C3-1', 'ios/App/App/Info.plist exists', `missing at ${path.relative(ROOT, plistPath)}`);
  }
  const iosIndex = path.join(ROOT, 'ios', 'App', 'App', 'public', 'index.html');
  check('AC-C3-2', 'ios/App/App/public/index.html exists (npx cap copy ios ran)', existsSync(iosIndex));
}

/* ------------------------------------------------------------------ report */

function report() {
  const failed = results.filter((r) => r.ok === false);
  console.log('\n--- QA-12 Android build check ---');
  for (const r of results) {
    const mark = r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.id}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  }
  console.log(
    `\n${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, ${skipped} skipped`,
  );
  if (bakedUrl) console.log(`baked homeserver URL inside the APK: ${bakedUrl}`);
  console.log(`APK extracted to ${path.relative(ROOT, TMP)} (delete it freely).`);
  return failed.length;
}

process.exit(report() ? 1 : 0);
