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
 * dev compiles it first. E2E_PREBUILT=1 starts a build already in `.next`
 * (CI builds once and hands it to each `--shard`).
 */

import { defineConfig, devices } from '@playwright/test';
import {
  MEMORY_BASE_URL,
  MEMORY_PORT,
  LLM_STUB_PORT,
  SANDBOX_STUB_PORT,
  SANDBOX_STUB_URL,
} from './e2e/constants';
import { memoryServerEnv } from './e2e/server-env';

// A Chromium other than the one this Playwright version downloads (a
// sandbox's preinstalled browser): name it, and every project uses it.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath, args: ['--no-sandbox'] } : {};
// Otherwise Playwright's own Chromium, and the full build, not the headless
// shell it picks by default (CI installs that build alone). The shell is an
// older headless that differs from Chrome where specs look: a navigation
// that a form or link sends on to another origin by a redirect (the OAuth
// consent page's answer to a client's loopback callback) never reaches
// page.route there, and Notification.permission stays "denied" after
// grantPermissions(['notifications']), so Preferences never subscribes.
// The full build in headless mode behaves as the Chrome people run.
const channel = executablePath ? undefined : 'chromium';

const START = `pnpm start -p ${MEMORY_PORT} --keepAliveTimeout 120000`;

// The specs desktop-dark runs. Every other spec runs once, in light: its
// behaviour does not depend on the theme. These either look at the theme
// (the screenshot gallery, GitHub's mark inverted on dark) or take their
// phone-width paths in one of the two projects, so both halves need both.
const DARK_SPECS = [
  // The theme itself.
  'screenshots.spec.ts',
  'connector-logos.spec.ts',
  // One project walks the phone-width path, the other the desktop one.
  'code.spec.ts',
  'branch-switcher.spec.ts',
  'code-file-management.spec.ts',
  'pr-subscriptions.spec.ts',
  'project-pulls-commits.spec.ts',
];

// The tour walk (every tour, every step, a screenshot each) is a standalone
// review run, not part of the suite or CI: `pnpm --filter renkei e2e:tours`.
const TOURS = Boolean(process.env.E2E_TOURS);

export default defineConfig({
  testDir: './e2e',
  testIgnore: TOURS ? [] : ['coach-marks-walk.spec.ts'],
  outputDir: 'test-results',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  fullyParallel: true,
  // The store is in-process memory with no IO: the box's four CPUs (a
  // GitHub ubuntu-latest runner has as many) keep four browsers busy.
  workers: 4,
  use: {
    baseURL: MEMORY_BASE_URL,
    timezoneId: 'UTC',
    locale: 'en-US',
    // A failure keeps its trace and a screenshot (test-results/; CI uploads
    // them from a failed shard); a pass leaves nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel,
    launchOptions,
    // The OS's "reduce motion" on: the app ends every transition and
    // animation at once (app/globals.css), so no step waits out a slide or
    // fade that a busy CI CPU has stretched past its timeout.
    contextOptions: { reducedMotion: 'reduce' },
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
      testMatch: DARK_SPECS,
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
      // A built server keeps idle connections well past Node's 5 seconds:
      // otherwise one it closes just as a spec's request reuses it fails
      // that request with ECONNRESET, which four busy workers hit now and then.
      command: process.env.E2E_PREBUILT
        ? START
        : process.env.CI
          ? `pnpm build && ${START}`
          : `pnpm dev -p ${MEMORY_PORT}`,
      url: `${MEMORY_BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: memoryServerEnv(),
    },
  ],
});
