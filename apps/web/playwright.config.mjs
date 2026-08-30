import { defineConfig, devices } from '@playwright/test';
import { requireEnv } from '@altitude/shared/env';
import { appUrl, loadEnv } from './e2e/database.mjs';

// The config is read before anything else runs, so the env file has to be
// loaded here rather than in global setup.
loadEnv();

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The end-to-end run.
 *
 * It exists because of a bug that reached a person: a function passed from a
 * server component to a client one. That compiles, typechecks, lints and
 * builds, and throws on the first render - so nothing in CI could see it, and
 * neither could anyone who was not looking at the screen. A single journey
 * through the real application closes that whole class.
 *
 * Port 3100, not 3000: `pnpm dev` is usually already sitting on 3000, and a
 * test suite that kills a developer's server to make room is a test suite that
 * gets run once.
 */
export default defineConfig({
  testDir: './e2e',
  // Chromium alone. The value here is that the pages render and the flows work
  // against a real database; browser differences are a separate question, and
  // paying three times the runtime for it on every commit is not worth it yet.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './e2e/global-setup.mjs',
  fullyParallel: false,
  // One worker: the journey signs up, creates the household and posts against a
  // single database. Parallel copies would be racing over the same rows.
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: process.env['CI'] !== undefined ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // The production build, not the dev server. A runtime boundary error is
    // exactly the kind of thing the two can disagree about, and production is
    // the one that matters.
    // Started, not built: the build runs first in the test:e2e script, so a
    // compile error is reported as a compile error rather than as "the server
    // would not start", and a killed run leaves no build lock behind.
    command: `pnpm exec next start --port ${String(PORT)}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: appUrl(),
      AUTH_SECRET: requireEnv('AUTH_SECRET', 'Generate with: openssl rand -base64 32'),
      ALTITUDE_BASE_URL: BASE_URL,
      NODE_ENV: 'production',
    },
  },
});
