// Browser tests of the Composer against the built site.
//
//   (repository root) jekyll build                     -> _site/
//   (tests)           npm install && npx playwright install chromium firefox webkit
//   (tests)           npx playwright test
//
// COMPOSER_SITE selects another site directory, COMPOSER_SCREENS a directory for review screenshots.
import { defineConfig, devices } from '@playwright/test';

const site = process.env.COMPOSER_SITE ?? '../_site';
const port = 4173;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  // animations and timing on shared runners: one retry in continuous integration, reported as flaky
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node e2e/serve.mjs "${site}" ${port}`,
    url: `http://127.0.0.1:${port}/composer/`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ],
});
