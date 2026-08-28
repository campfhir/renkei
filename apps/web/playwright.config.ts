/**
 * Playwright config for screenshot-driven UI work (specs live in e2e/,
 * named *.spec.ts so Jest's glob for .test.ts files never collects them).
 *
 * Local-only tooling: it needs the dev Postgres from the repo's
 * docker-compose.yml plus the root .env.development — CI runs no browser
 * suite. Traces are OFF on purpose: a trace artifact once captured a live
 * Azure AD client secret (see .gitignore's note); opt in per-run with
 * `--trace on` only against pages that render no credentials.
 */

import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Env (DATABASE_URL, TOKEN_ENCRYPTION_KEY) lives in the repo-root
// .env.development; absent file is fine when the vars are already exported.
const HERE = import.meta.dirname;
try {
  process.loadEnvFile(path.resolve(HERE, '../../.env.development'));
} catch {
  // Already-set environment wins; the webServer env below passes it through.
}

const BASE_URL = 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  reporter: [['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    storageState: path.join(HERE, 'test-results', 'storage-state.json'),
    // LocalTime SSRs UTC and swaps to the browser zone on hydration; pinning
    // UTC makes both renders identical, so screenshots never flake on time.
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'desktop-light',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      },
    },
    {
      name: 'desktop-dark',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
      },
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
      ...(process.env.TOKEN_ENCRYPTION_KEY
        ? { TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY }
        : {}),
      // instrumentation.ts refuses to boot without this, so a shot run dies
      // before the first page loads. Passed through when set, exactly like
      // the other two — no key is invented here.
      ...(process.env.LOG_ENCRYPTION_KEY
        ? { LOG_ENCRYPTION_KEY: process.env.LOG_ENCRYPTION_KEY }
        : {}),
    },
  },
});
