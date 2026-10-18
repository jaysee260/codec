import { defineConfig, devices } from '@playwright/test';

/**
 * QA owns this file (docs/TICKETS.md QA-1, docs/PHASE2_TICKETS.md QA-8).
 *
 * Preconditions for a run:
 *  - Synapse up and seeded on http://localhost:8008 (`npm run hs:up && npm run seed`);
 *  - `seed/seed-output.json` present (the fixtures read room/event ids from it);
 *  - port 5173 free, or a dev server already listening on it (it is reused).
 *
 * ## Projects
 *
 * | project | device | specs | outputDir |
 * |---|---|---|---|
 * | `desktop` | Desktop Chrome 1280x720 | Phase 1 (`shell`, `navigation`, `conversation`, `smoke`) + Phase 3 `threads` + Phase 4 `gif` | `e2e/results/desktop` |
 * | `mobile`  | `devices['Pixel 7']` (412x839, touch, isMobile) | Phase 2 (`voice`, `mobile-nav`, `mobile-smoke`) + Phase 3 `mobile-threads` + Phase 4 `mobile-gif` + voice format `voice-compat`, `ogg-remux` | `e2e/results/mobile` |
 *
 * Voice format (docs/VOICE_FORMAT_PLAN.md): `voice-compat.spec.ts` (old-iPhone simulation, native vs
 * fallback playback) and `ogg-remux.spec.ts` (the Node-side WebM -> Ogg remuxer; no page, so it costs
 * no browser) are listed in **both** regexes like `mobile-threads`: they run in `mobile` only, so
 * `--project=mobile` covers the whole voice feature and neither runs twice.
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
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
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
      testIgnore: /(voice|voice-compat|ogg-remux|mobile-nav|mobile-smoke|mobile-threads|mobile-gif)\.spec\.ts$/,
      outputDir: './e2e/results/desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      testMatch: /(voice|voice-compat|ogg-remux|mobile-nav|mobile-smoke|mobile-threads|mobile-gif)\.spec\.ts$/,
      outputDir: './e2e/results/mobile',
      use: { ...devices['Pixel 7'], permissions: ['microphone'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
