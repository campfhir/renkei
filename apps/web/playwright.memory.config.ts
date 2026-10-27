/**
 * The UI suite on the in-memory data store: layout, navigation and the
 * pages' own behavior, with no Postgres, no delegate, and no stubs to
 * start — one Next server with RENKEI_DATA_STORE=memory
 * (packages/db/src/store/memory.ts), seeded per spec through
 * app/api/test/data-store (e2e/memory/fixtures.ts).
 *
 * What it can cover is what sits behind the data store
 * (packages/db/src/store/types.ts): sessions, identities, preferences,
 * org settings, coach marks and notifications today. A page that still
 * queries the database directly renders as it does with the database down
 * — so a spec here asserts on what the store answers, and the database
 * side of the same contract is checked without a browser by
 * packages/db's contract suite.
 *
 * Calls that leave the web process (the delegate behind /api/keys) are
 * answered at the browser edge with page.route, as the full suite answers
 * vendor APIs.
 *
 * Locally: `pnpm e2e:memory` (dev server on :3100, so it runs beside the
 * full suite's :3000). In CI the app is built and started instead — a
 * production build answers a cold route in milliseconds where dev compiles
 * it first.
 */

import { defineConfig, devices } from '@playwright/test';
import { MEMORY_SEED_TOKEN, MEMORY_BASE_URL, MEMORY_PORT } from './e2e/memory/constants';

// A Chromium other than the one this Playwright version downloads (a
// sandbox's preinstalled browser): name it, and every project uses it.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath, args: ['--no-sandbox'] } : {};

export default defineConfig({
  testDir: './e2e/memory',
  outputDir: 'test-results/memory',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  fullyParallel: true,
  use: {
    baseURL: MEMORY_BASE_URL,
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'off',
    screenshot: 'off',
    launchOptions,
  },
  projects: [
    {
      name: 'desktop-light',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
        launchOptions,
      },
    },
    {
      name: 'desktop-dark',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
        launchOptions,
      },
    },
  ],
  webServer: {
    command: process.env.CI
      ? `pnpm build && pnpm start -p ${MEMORY_PORT}`
      : `pnpm dev -p ${MEMORY_PORT}`,
    url: `${MEMORY_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      RENKEI_DATA_STORE: 'memory',
      RENKEI_MEMORY_SEED_TOKEN: MEMORY_SEED_TOKEN,
      // Nothing to reach, and nothing should try: the delegate's absence is
      // answered at the browser edge (e2e/memory/fixtures.ts).
      DELEGATE_WORKER_URL: 'http://127.0.0.1:9',
      DELEGATE_WORKER_API_KEY: 'e2e-memory-delegate-key',
      BLOB_STORE_PROVIDER: 'local',
    },
  },
});
