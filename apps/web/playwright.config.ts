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
import { E2E_SETUP_SECRET } from './e2e/setup-secret';

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
  // One worker per stack global setup starts (e2e/stacks.ts).
  workers: Number(process.env.E2E_WORKERS ?? 3),
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
  webServer: [
    {
      // A stand-in sandbox worker for the Code pages (e2e/sandbox-stub.mjs):
      // the app reaches it at the SANDBOX_WORKER_URL the env file names.
      command: 'node e2e/sandbox-stub.mjs',
      url: 'http://127.0.0.1:8092/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // A stand-in remote MCP server with its own OAuth (e2e/mcp-stub.mjs):
      // dynamic registration, PKCE, both transports, one open endpoint.
      command: 'node e2e/mcp-stub.mjs',
      url: 'http://127.0.0.1:8093/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
