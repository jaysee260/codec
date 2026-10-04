#!/usr/bin/env node
/**
 * Android toolchain resolver (Phase 2). Finds a JDK and the Android SDK without relying on PATH order
 * (this machine has a Java 8 JRE first on PATH), and exports the env the Gradle build needs.
 *
 *   node scripts/toolchain.mjs            print what was found + checks (exit 1 when something is missing)
 *   node scripts/toolchain.mjs --setx     also persist JAVA_HOME / ANDROID_HOME for the current Windows user
 *   node scripts/toolchain.mjs --env      print `export JAVA_HOME=...` lines for a shell
 *
 * Lookup order (first hit wins):
 *   JAVA_HOME     env JAVA_HOME -> ~/jdk21 -> ~/jdk17 -> C:/Program Files/Eclipse Adoptium/jdk-21* -> /usr/lib/jvm/* -> macOS JVMs
 *   ANDROID_HOME  env ANDROID_HOME -> env ANDROID_SDK_ROOT -> ~/android-sdk -> %LOCALAPPDATA%/Android/Sdk -> ~/Library/Android/sdk -> ~/Android/Sdk
 *
 * Capacitor 7's Android template compiles with Java 21 (`JavaVersion.VERSION_21`); JDK 17 is not enough.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const javaExe = WIN ? 'java.exe' : 'java';

/** Required by Capacitor 7's Android template (variables.gradle / build-tools). */
export const REQUIRED = { javaMajor: 21, platform: 'android-35', buildTools: '35.0.0' };

function fwd(p) {
  return p ? p.replace(/\\/g, '/') : p;
}

function hasJava(dir) {
  return !!dir && existsSync(path.join(dir, 'bin', javaExe));
}

function globDirs(parent, prefix) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => path.join(parent, d.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** JDK major version from `<javaHome>/release` (JAVA_VERSION="21.0.1"), or 0. */
export function javaMajor(javaHome) {
  try {
    const rel = readFileSync(path.join(javaHome, 'release'), 'utf8');
    const m = /JAVA_VERSION="(\d+)(?:\.(\d+))?/.exec(rel);
    if (!m) return 0;
    const major = Number(m[1]);
    return major === 1 ? Number(m[2] ?? 0) : major; // 1.8 -> 8
  } catch {
    return 0;
  }
}

export function findJavaHome() {
  const candidates = [
    process.env.JAVA_HOME,
    path.join(HOME, 'jdk21'),
    path.join(HOME, 'jdk17'),
    ...globDirs('C:/Program Files/Eclipse Adoptium', 'jdk-21'),
    ...globDirs('C:/Program Files/Eclipse Adoptium', 'jdk-17'),
    ...globDirs('C:/Program Files/Java', 'jdk-21'),
    ...globDirs('C:/Program Files/Android/Android Studio', 'jbr'),
    ...globDirs('/usr/lib/jvm', 'java-21'),
    ...globDirs('/usr/lib/jvm', 'temurin-21'),
    ...globDirs('/Library/Java/JavaVirtualMachines', 'temurin-21').map((d) => path.join(d, 'Contents', 'Home')),
  ];
  // Prefer the first candidate that is actually >= the required major; fall back to any JDK for diagnostics.
  const found = candidates.filter(hasJava);
  return found.find((d) => javaMajor(d) >= REQUIRED.javaMajor) ?? found[0];
}

export function findAndroidHome() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(HOME, 'android-sdk'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
    path.join(HOME, 'Library', 'Android', 'sdk'),
    path.join(HOME, 'Android', 'Sdk'),
  ];
  return candidates.find((d) => !!d && (existsSync(path.join(d, 'platform-tools')) || existsSync(path.join(d, 'cmdline-tools'))));
}

/** Everything a build needs. `problems` is empty when the toolchain is complete. */
export function resolveToolchain() {
  const javaHome = findJavaHome();
  const androidHome = findAndroidHome();
  const major = javaHome ? javaMajor(javaHome) : 0;
  const problems = [];
  if (!javaHome) problems.push(`No JDK found. Extract a portable Temurin ${REQUIRED.javaMajor} to ~/jdk21 or set JAVA_HOME (docs/MOBILE.md).`);
  else if (major < REQUIRED.javaMajor) problems.push(`JDK at ${javaHome} is Java ${major}; Capacitor 7 needs ${REQUIRED.javaMajor}+.`);
  if (!androidHome) problems.push('No Android SDK found. Install the command-line tools to ~/android-sdk or set ANDROID_HOME (docs/MOBILE.md).');
  else {
    if (!existsSync(path.join(androidHome, 'platforms', REQUIRED.platform))) problems.push(`Missing platforms;${REQUIRED.platform} in ${androidHome} (sdkmanager "platforms;${REQUIRED.platform}").`);
    if (!existsSync(path.join(androidHome, 'build-tools', REQUIRED.buildTools))) problems.push(`Missing build-tools;${REQUIRED.buildTools} in ${androidHome}.`);
    if (!existsSync(path.join(androidHome, 'platform-tools'))) problems.push(`Missing platform-tools (adb) in ${androidHome}.`);
  }
  const env = { ...process.env };
  if (javaHome) env.JAVA_HOME = fwd(javaHome);
  if (androidHome) {
    env.ANDROID_HOME = fwd(androidHome);
    env.ANDROID_SDK_ROOT = fwd(androidHome);
  }
  const pathParts = [];
  if (javaHome) pathParts.push(path.join(javaHome, 'bin'));
  if (androidHome) pathParts.push(path.join(androidHome, 'platform-tools'));
  const PATH_KEY = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[PATH_KEY] = [...pathParts, env[PATH_KEY] ?? ''].join(path.delimiter);
  return { javaHome: fwd(javaHome), javaMajor: major, androidHome: fwd(androidHome), problems, env, pathKey: PATH_KEY };
}

export function adbPath(androidHome) {
  if (!androidHome) return undefined;
  const p = path.join(androidHome, 'platform-tools', WIN ? 'adb.exe' : 'adb');
  return existsSync(p) ? p : undefined;
}

/**
 * Make plain `gradlew` / Android Studio use the resolved JDK on this machine regardless of PATH order (Java 8
 * is first on PATH here) by writing `org.gradle.java.home` to the USER's ~/.gradle/gradle.properties - never to
 * the committed android/gradle.properties, which would break every other machine. Idempotent; returns what it did.
 */
export function ensureUserGradleJavaHome(javaHome) {
  if (!javaHome) return 'skipped (no JDK)';
  const dir = path.join(HOME, '.gradle');
  const file = path.join(dir, 'gradle.properties');
  const line = `org.gradle.java.home=${fwd(javaHome)}`;
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* no file yet */
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === line)) return `already set in ${fwd(file)}`;
  const kept = current
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('org.gradle.java.home='))
    .join('\n')
    .replace(/\n*$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${kept ? kept + '\n' : ''}${line}\n`);
  return `wrote ${line} to ${fwd(file)}`;
}

function main() {
  const args = process.argv.slice(2);
  const tc = resolveToolchain();
  if (args.includes('--env')) {
    if (tc.javaHome) console.log(`export JAVA_HOME="${tc.javaHome}"`);
    if (tc.androidHome) console.log(`export ANDROID_HOME="${tc.androidHome}"`);
    if (tc.javaHome || tc.androidHome) console.log(`export PATH="${[tc.javaHome && `${tc.javaHome}/bin`, tc.androidHome && `${tc.androidHome}/platform-tools`].filter(Boolean).join(':')}:$PATH"`);
    return;
  }
  console.log(`JAVA_HOME    ${tc.javaHome ?? '(not found)'}${tc.javaHome ? `  (Java ${tc.javaMajor})` : ''}`);
  console.log(`ANDROID_HOME ${tc.androidHome ?? '(not found)'}`);
  if (tc.androidHome) {
    const list = (sub) => {
      try {
        return readdirSync(path.join(tc.androidHome, sub)).join(', ');
      } catch {
        return '(none)';
      }
    };
    console.log(`  platforms   ${list('platforms')}`);
    console.log(`  build-tools ${list('build-tools')}`);
    console.log(`  adb         ${adbPath(tc.androidHome) ?? '(missing)'}`);
  }
  if (args.includes('--setx')) {
    if (!WIN) console.log('--setx only applies to Windows; on macOS/Linux add the --env lines to your shell profile.');
    else {
      for (const [k, v] of [['JAVA_HOME', tc.javaHome], ['ANDROID_HOME', tc.androidHome]]) {
        if (!v) continue;
        const r = spawnSync('setx', [k, v.replace(/\//g, '\\')], { encoding: 'utf8' });
        console.log(r.status === 0 ? `setx ${k} ok (new shells only)` : `setx ${k} failed: ${r.stderr || r.stdout}`);
      }
      console.log('Not touching PATH with setx (it truncates at 1024 chars); scripts prepend JAVA_HOME/bin themselves.');
    }
    console.log(`gradle: ${ensureUserGradleJavaHome(tc.javaHome)}`);
  }
  if (tc.problems.length) {
    console.log('');
    for (const p of tc.problems) console.log(`PROBLEM  ${p}`);
    process.exitCode = 1;
  } else {
    console.log('');
    console.log(`Toolchain OK for Capacitor 7 (Java ${REQUIRED.javaMajor}, ${REQUIRED.platform}, build-tools ${REQUIRED.buildTools}).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
