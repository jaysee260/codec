import { defineConfig, devices } from '@playwright/test';

/**
 * QA owns this file (docs/TICKETS.md QA-1).
 *
 * Preconditions for a run:
 *  - Synapse up and seeded on http://localhost:8008 (`npm run hs:up && npm run seed`);
 *  - `seed/seed-output.json` present (the fixtures read room/event ids from it);
 *  - port 5173 free, or a dev server already listening on it (it is reused).
 *
 * Artefacts all land under `e2e/results/`:
 *  - `e2e/results/<test>/` traces, failure screenshots and videos;
 *  - `e2e/results/demo/` one full-page screenshot per demo step, written even when green
 *    (QA-3: the set is the stakeholder pre-read);
 *  - `playwright-report/` the HTML report.
 *
 * Workers are pinned to 1 and `fullyParallel` is off: the suite drives one shared homeserver and
 * a handful of tests assert on live cross-user updates, so concurrent writes would be unreadable.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
