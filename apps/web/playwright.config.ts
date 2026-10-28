/**
 * The UI suite on the in-memory data store (packages/db/src/store/memory.ts):
 * one Next server with RENKEI_DATA_STORE=memory, and no Postgres anywhere.
 *
 * The server runs, in its own process and on the same store, the real
 * delegate (lib/memory-delegate.ts) — so people enroll and chats open
 * their keys exactly as in a deployment — and the background consumers a
 * UI flow waits on (lib/memory-workers.ts): the agents worker's run
 * engine and action executor, and the event dispatcher. Beside it start
 * three stateless stubs: the sandbox worker (:8092), a remote MCP server
 * (:8093) and a model (:8094, e2e/llm-stub.mjs).
 *
 * Specs sign in through the one test-only route (app/api/test/session,
 * via e2e/fixtures.ts → e2e/support/person.ts) and stage everything else
 * through the REST routes the UI itself calls.
 *
 * Locally: `pnpm e2e` or `npx playwright test <spec>` (a dev server on
 * :3100, reused while it is up). In CI the app is built and started
 * instead — a production build answers a cold route in milliseconds where
 * dev compiles it first.
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
  LLM_STUB_PORT,
  SANDBOX_STUB_PORT,
  SANDBOX_STUB_URL,
  E2E_SETUP_SECRET,
} from './e2e/constants';

const HERE = import.meta.dirname;

// A Chromium other than the one this Playwright version downloads (a
// sandbox's preinstalled browser): name it, and every project uses it.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath, args: ['--no-sandbox'] } : {};

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
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
  webServer: [
    {
      // A stand-in sandbox worker (e2e/sandbox-stub.mjs): Code pages, the
      // chat's sandbox tools, Bitbucket's and Jira administration's APIs.
      // No vendor's OAuth: connect flows are the in-memory app's own fake
      // grants (packages/provider-grants/src/fake-oauth.ts).
      // SANDBOX_STUB_PORT moves it.
      command: `SANDBOX_STUB_PORT=${SANDBOX_STUB_PORT} node e2e/sandbox-stub.mjs`,
      url: `${SANDBOX_STUB_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // A stand-in remote MCP server with its own OAuth (e2e/mcp-stub.mjs).
      command: 'node e2e/mcp-stub.mjs',
      url: `http://127.0.0.1:${process.env.E2E_MCP_STUB_PORT ?? 8093}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // A stand-in model (e2e/llm-stub.mjs): the fixed reply that lets an
      // agent run or a chat turn finish.
      command: 'node e2e/llm-stub.mjs',
      url: `http://127.0.0.1:${LLM_STUB_PORT}/health`,
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
        // The in-process agents worker runs tools through this server's
        // own MCP endpoint (lib/memory-workers.ts).
        RENKEI_WEB_INTERNAL_URL: MEMORY_BASE_URL,
        // The sandbox stub stands in for the sandbox worker and the hosts' APIs.
        SANDBOX_WORKER_URL: SANDBOX_STUB_URL,
        SANDBOX_WORKER_API_KEY: 'e2e-sandbox-key',
        SETUP_SECRET: E2E_SETUP_SECRET,
        BITBUCKET_API_BASE_URL: `${SANDBOX_STUB_URL}/bitbucket/2.0`,
        GITHUB_API_BASE_URL: `${SANDBOX_STUB_URL}/github`,
        JIRA_ADMIN_API_BASE_URL: `${SANDBOX_STUB_URL}/jira`,
        JIRA_AUTOMATION_API_BASE_URL: `${SANDBOX_STUB_URL}/automation`,
        BLOB_STORE_PROVIDER: process.env.BLOB_STORE_PROVIDER ?? 'local',
        BLOB_STORE_LOCAL_DIR:
          process.env.BLOB_STORE_LOCAL_DIR ?? path.join(HERE, 'test-results', 'blobs'),
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
