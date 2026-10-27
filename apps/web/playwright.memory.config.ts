/**
 * The UI suite on the in-memory data store (packages/db/src/store/memory.ts):
 * one Next server with RENKEI_DATA_STORE=memory, and no Postgres anywhere.
 *
 * The server runs the real delegate in its own process
 * (lib/memory-delegate.ts), on the same store, so people enroll and chats
 * open their keys exactly as in a deployment. The sandbox stub (:8092) and
 * the MCP stub (:8093) start beside it, as in the Postgres suite
 * (playwright.config.ts), whose dev-server environment this mirrors.
 *
 * Specs seed through the store methods the app writes with, posted to the
 * test-only app/api/test/data-store route (e2e/support/store.ts); a person
 * of the test's own comes from e2e/memory/fixtures.ts
 * (e2e/support/person.ts). The org-wide fixtures e2e/seed.ts writes to
 * Postgres are written once per server by globalSetup
 * (e2e/support/global-setup.ts → e2e/support/fixtures.ts).
 *
 * Locally: `pnpm e2e:memory` (dev server on :3100, so it runs beside the
 * full suite's :3000). In CI the app is built and started instead — a
 * production build answers a cold route in milliseconds where dev compiles
 * it first.
 */

import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  MEMORY_SEED_TOKEN,
  MEMORY_BASE_URL,
  MEMORY_PORT,
  MEMORY_TOKEN_ENCRYPTION_KEY,
  MEMORY_DELEGATE_URL,
  MEMORY_DELEGATE_API_KEY,
} from './e2e/memory/constants';
import { E2E_SETUP_SECRET } from './e2e/setup-secret';

const HERE = import.meta.dirname;

// A Chromium other than the one this Playwright version downloads (a
// sandbox's preinstalled browser): name it, and every project uses it.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath, args: ['--no-sandbox'] } : {};

export default defineConfig({
  testDir: './e2e/memory',
  outputDir: 'test-results/memory',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/support/global-setup.ts',
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
  webServer: [
    {
      // A stand-in sandbox worker (e2e/sandbox-stub.mjs): Code pages, the
      // chat's sandbox tools, Bitbucket and Jira administration's APIs.
      command: 'node e2e/sandbox-stub.mjs',
      url: 'http://127.0.0.1:8092/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // A stand-in remote MCP server with its own OAuth (e2e/mcp-stub.mjs).
      command: 'node e2e/mcp-stub.mjs',
      url: 'http://127.0.0.1:8093/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: process.env.CI
        ? `pnpm build && pnpm start -p ${MEMORY_PORT}`
        : `pnpm dev -p ${MEMORY_PORT}`,
      url: `${MEMORY_BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        RENKEI_DATA_STORE: 'memory',
        RENKEI_MEMORY_SEED_TOKEN: MEMORY_SEED_TOKEN,
        // The server starts its own delegate (lib/memory-delegate.ts) at
        // this URL with this key: named here, never made up at boot, since
        // `next dev` rebuilds and reloads every page when the environment
        // changes under it. The secrets key is the suite's fixed one,
        // which specs seal with too.
        DELEGATE_WORKER_URL: MEMORY_DELEGATE_URL,
        DELEGATE_WORKER_API_KEY: MEMORY_DELEGATE_API_KEY,
        TOKEN_ENCRYPTION_KEY: MEMORY_TOKEN_ENCRYPTION_KEY,
        // What playwright.config.ts gives the Postgres suite's dev server
        // (and its .env.development the sandbox pair), the same values.
        SANDBOX_WORKER_URL: 'http://127.0.0.1:8092',
        SANDBOX_WORKER_API_KEY: 'e2e-sandbox-key',
        SETUP_SECRET: E2E_SETUP_SECRET,
        BITBUCKET_API_BASE_URL: 'http://127.0.0.1:8092/bitbucket/2.0',
        JIRA_ADMIN_API_BASE_URL: 'http://127.0.0.1:8092/jira',
        JIRA_AUTOMATION_API_BASE_URL: 'http://127.0.0.1:8092/automation',
        BLOB_STORE_PROVIDER: process.env.BLOB_STORE_PROVIDER ?? 'local',
        BLOB_STORE_LOCAL_DIR:
          process.env.BLOB_STORE_LOCAL_DIR ?? path.join(HERE, 'test-results', 'memory', 'blobs'),
        ...(process.env.AZURE_BLOB_ACCOUNT
          ? { AZURE_BLOB_ACCOUNT: process.env.AZURE_BLOB_ACCOUNT }
          : {}),
        ...(process.env.AZURE_BLOB_KEY ? { AZURE_BLOB_KEY: process.env.AZURE_BLOB_KEY } : {}),
        ...(process.env.AZURE_BLOB_CONTAINER
          ? { AZURE_BLOB_CONTAINER: process.env.AZURE_BLOB_CONTAINER }
          : {}),
        ...(process.env.AZURE_BLOB_ENDPOINT
          ? { AZURE_BLOB_ENDPOINT: process.env.AZURE_BLOB_ENDPOINT }
          : {}),
      },
    },
  ],
});
