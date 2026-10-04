#!/usr/bin/env node
/**
 * Build the Android debug APK (Phase 2, PRIN-1). Cross-platform (Git Bash, PowerShell, cmd, macOS, Linux):
 * resolves the JDK and Android SDK itself (scripts/toolchain.mjs), so it works from a fresh shell with no
 * env vars and with Java 8 first on PATH.
 *
 *   npm run cap:build:android              vite build (VITE_HS_URL from the env, else the web default) + cap sync + gradle
 *   npm run cap:build:android:lan          same, but bakes VITE_HS_URL=http://<this PC's LAN IP>:8009 (the hs:lan proxy)
 *   node scripts/cap-build-android.mjs --hs http://10.0.0.5:8009      explicit homeserver URL to bake
 *   node scripts/cap-build-android.mjs --install                        then `adb install -r` on the connected phone
 *   node scripts/cap-build-android.mjs --skip-web                       gradle only (dist/ and the sync are reused)
 *   node scripts/cap-build-android.mjs --release                        assembleRelease (unsigned) instead of assembleDebug
 *
 * Output: android/app/build/outputs/apk/debug/app-debug.apk (path printed at the end).
 * Exit codes: 0 ok, 2 toolchain missing (reason printed; see docs/MOBILE.md), 1 build failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbPath, ensureUserGradleJavaHome, resolveToolchain } from './toolchain.mjs';
import { LAN_PROXY_PORT, lanHomeserverUrl } from './lib/lan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function run(cmd, { cwd = ROOT, env }) {
  console.log(`\n> ${cmd}`);
  const r = spawnSync(cmd, { cwd, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`\n[cap-build-android] "${cmd}" exited with ${r.status ?? r.signal}`);
    process.exit(1);
  }
}

const tc = resolveToolchain();
if (tc.problems.length) {
  console.error('[cap-build-android] cannot build: toolchain incomplete');
  for (const p of tc.problems) console.error(`  - ${p}`);
  console.error('  See docs/MOBILE.md "Toolchain". (`node scripts/toolchain.mjs` shows what was found.)');
  process.exit(2);
}
console.log(`[cap-build-android] JAVA_HOME=${tc.javaHome} (Java ${tc.javaMajor})  ANDROID_HOME=${tc.androidHome}`);

// Homeserver URL baked into the bundle (VITE_HS_URL is read at build time by src/lib/matrix/config.ts).
let hsUrl = value('--hs') ?? process.env.VITE_HS_URL;
if (flag('--lan') && !value('--hs')) {
  hsUrl = lanHomeserverUrl(LAN_PROXY_PORT);
  if (!hsUrl) {
    console.error('[cap-build-android] --lan: no LAN IPv4 address found (offline?). Pass --hs http://<ip>:8009 instead.');
    process.exit(2);
  }
}
const env = { ...tc.env };
if (hsUrl) env.VITE_HS_URL = hsUrl;
console.log(`[cap-build-android] baked homeserver URL: ${hsUrl ?? 'http://localhost:8008 (web default; change it on the login screen > Advanced)'}`);

// Gradle finds the SDK through local.properties (what Android Studio writes) as well as ANDROID_HOME, and the
// JDK through JAVA_HOME here plus org.gradle.java.home in the user's ~/.gradle/gradle.properties for plain gradlew runs.
writeFileSync(path.join(ANDROID, 'local.properties'), `sdk.dir=${tc.androidHome}\n`);
console.log(`[cap-build-android] gradle: ${ensureUserGradleJavaHome(tc.javaHome)}`);

if (!flag('--skip-web')) {
  run('npx vite build', { env });
  run('npx cap sync android', { env });
} else if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('[cap-build-android] --skip-web but dist/ is missing; run without --skip-web first.');
  process.exit(1);
}

const task = flag('--release') ? 'assembleRelease' : 'assembleDebug';
// Absolute path: cmd.exe (shell: true) does not reliably resolve a bare `gradlew.bat` from `cwd`.
const gradlew = path.join(ANDROID, WIN ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}" ${task} --console=plain`, { cwd: ANDROID, env });

const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', flag('--release') ? 'release' : 'debug', flag('--release') ? 'app-release-unsigned.apk' : 'app-debug.apk');
if (!existsSync(apk)) {
  console.error(`[cap-build-android] build finished but ${apk} is missing`);
  process.exit(1);
}
const mb = (statSync(apk).size / 1024 / 1024).toFixed(1);
console.log(`\n[cap-build-android] APK: ${apk} (${mb} MB)`);
console.log(`[cap-build-android] relative: android/app/build/outputs/apk/${flag('--release') ? 'release/app-release-unsigned.apk' : 'debug/app-debug.apk'}`);
if (hsUrl) console.log(`[cap-build-android] default homeserver inside the APK: ${hsUrl}`);

if (flag('--install')) {
  const adb = adbPath(tc.androidHome);
  if (!adb) {
    console.error('[cap-build-android] --install: adb not found in platform-tools');
    process.exit(1);
  }
  run(`"${adb}" install -r "${apk}"`, { env });
  console.log('[cap-build-android] installed. On the phone: open "Matrix POC".');
}
