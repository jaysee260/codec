import { defineConfig, devices } from '@playwright/test';
import { baseUrlFor, hsUrlFor, poolSize, workerIndex } from './e2e/fixtures/pool.ts';

/**
 * QA owns this file (docs/TICKETS.md QA-1, docs/PHASE2_TICKETS.md QA-8).
 *
 * ## Parallel runs (issue #2, docs/PERF_PLAN.md)
 *
 * The suite runs on N workers (`E2E_WORKERS`; default in `e2e/fixtures/pool.ts`), one Synapse + one Vite per worker:
 * worker i (`TEST_PARALLEL_INDEX`) uses http://localhost:${8008+i} and http://localhost:${5173+i}. `globalSetup`
 * (`e2e/global-setup.ts`) restores every Synapse from one seeded snapshot (`scripts/hs-pool.mjs`, needs a Synapse
 * venv or Docker) and stops them at the end, so every run starts pristine; the N Vite servers are the `webServer`
 * entries below (`VITE_HS_URL` points each at its Synapse). Size the run with `E2E_WORKERS`, not `--workers`.
 *
 *  - `E2E_WORKERS=1` is the old single-server setup: 8008 / 5173, and a homeserver already running on 8008 is reused.
 *  - `E2E_REUSE_SERVERS=1` never starts or stops a homeserver (dev loops; WSL1 machines, with `E2E_WORKERS=1`).
 *  - `seed/seed-output.json` and `seed/e2ee-keys.json` are restored from the snapshot; ids are identical on every clone.
 *
 * ## Projects
 *
 * | project | device | specs | outputDir |
 * |---|---|---|---|
 * | `desktop` | Desktop Chrome 1280x720 | Phase 1 (`shell`, `navigation`, `conversation`, `smoke`) + Phase 3 `threads` + Phase 4 `gif` | `e2e/results/desktop` |
 * | `mobile`  | `devices['Pixel 7']` (412x839, touch, isMobile) | Phase 2 (`voice`, `mobile-nav`, `mobile-smoke`) + Phase 3 `mobile-threads` + Phase 4 `mobile-gif` | `e2e/results/mobile` |
 *
 * Phase 5 (QA-24..28): `e2ee-core`, `e2ee-media`, `e2ee-security` and smoke step 13 need no entry either (desktop
 * only, not in `mobile`'s regex). They open a second browser context for the other device (separate IndexedDB =
 * separate crypto store), so they are slow (~10 min for the three): `npm run test:e2e:e2ee`.
 *
 * Phase 4 (QA-19/20): `gif.spec.ts` likewise needs no entry in `desktop`, and `mobile-gif.spec.ts`
 * is listed in **both** regexes for the same reason `mobile-threads.spec.ts` is — see below.
 *
 * Phase 3 (QA-14): `threads.spec.ts` needs no entry — `desktop` takes everything the `testIgnore`
 * does not name — but `mobile-threads.spec.ts` is listed in **both** regexes on purpose: added to
 * `mobile`'s `testMatch` so it runs there, and to `desktop`'s `testIgnore` so it does not also run
 * at 1280x720 (where long-press and the sheet variant are meaningless).
 *
 * Each project has its **own** `outputDir` so `npm run test:e2e:mobile` does not wipe the desktop
 * run's traces (Playwright clears `outputDir` on start). The two demo screenshot sets live *outside*
 * both of them on purpose — `e2e/results/demo/` (Phase 1) and `e2e/demo-mobile/` (QA-11) survive any run.
 *
 * `npx playwright test` runs both projects; `--project=mobile` / `--project=desktop` (or
 * `npm run test:e2e:mobile` / `npm run test:e2e:desktop`) runs one. The Android APK check is *not* a
 * Playwright project — it is a browserless Node script (`npm run test:android-build`), so a bare
 * `npm run test:e2e` never triggers a 10-minute Gradle build.
 *
 * ## Fake media (QA-8, docs/advisor/fake-mic-probe.mjs)
 *
 * `launchOptions.args` are global because they are harmless to the desktop project:
 *  - `--use-fake-device-for-media-stream` a looping tone on `getUserMedia({ audio: true })`, so
 *    `MediaRecorder` produces real Opus bytes and the level meter actually moves;
 *  - `--use-fake-ui-for-media-stream` auto-accepts the permission prompt;
 *  - `--autoplay-policy=no-user-gesture-required` lets `<audio>.play()` resolve in headless.
 * The `mobile` project also grants `permissions: ['microphone']` on the context (the flag covers the
 * prompt, the grant covers the Permissions API that the app may query).
 */
const WORKERS = poolSize();

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: WORKERS,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: baseUrlFor(workerIndex()),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /(voice|mobile-nav|mobile-smoke|mobile-threads|mobile-gif)\.spec\.ts$/,
      outputDir: './e2e/results/desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      testMatch: /(voice|mobile-nav|mobile-smoke|mobile-threads|mobile-gif)\.spec\.ts$/,
      outputDir: './e2e/results/mobile',
      use: { ...devices['Pixel 7'], permissions: ['microphone'] },
    },
  ],
  // One Vite per worker. With one worker this is the historical `npm run dev` on 5173 (reused when already running).
  webServer: Array.from({ length: WORKERS }, (_, i) => ({
    command: `npm run dev -- --port ${new URL(baseUrlFor(i)).port || 5173} --strictPort`,
    url: baseUrlFor(i),
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
    env: { VITE_HS_URL: hsUrlFor(i) },
  })),
});
