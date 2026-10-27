/**
 * Each Playwright worker runs its own stack (stacks.ts), and every test file in
 * it starts from a database of its own: before a file that differs from the one
 * before, the worker stops its delegate and server, clones the template again,
 * starts both, and seeds. A file therefore never sees rows another file left.
 *
 * Specs opt in by importing from here instead of '@playwright/test'. Everything
 * else the specs take from Playwright is re-exported unchanged.
 */

import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test as base } from '@playwright/test';
import {
  cloneTemplate,
  readStack,
  seedDatabase,
  startDelegate,
  startServer,
  stop,
  waitForHttp,
  waitForLiveDelegate,
  type Stack,
} from './stacks';

export * from '@playwright/test';

const WORKERS_DIR = path.join(import.meta.dirname, '..', 'test-results', 'workers');

/** The file a worker's children are recorded in, so a restarted worker can stop them. */
function pidFile(index: number): string {
  return path.join(WORKERS_DIR, `w${index}.pids`);
}

/** Stops the children a worker before this one started, if any are still up. */
async function reapPreviousWorker(index: number): Promise<void> {
  let pids: number[] = [];
  try {
    pids = JSON.parse(readFileSync(pidFile(index), 'utf8'));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  rmSync(pidFile(index), { force: true });
}

/** This worker's children, and the file they were started from. */
let children: ChildProcess[] = [];

async function stopChildren(index: number): Promise<void> {
  await Promise.all(children.map(stop));
  children = [];
  rmSync(pidFile(index), { force: true });
}

/** Whether this file's server has been started yet. */
let serverUp = false;

/**
 * A fresh stack for one test file: database cloned and seeded, delegate started.
 * The server is not started here: it reads org settings as it boots, and a read
 * keeps the value for a minute, so it starts only once the file's own setup has
 * written its rows (see ensureServer).
 */
async function prepare(stack: Stack): Promise<void> {
  serverUp = false;
  await stopChildren(stack.index);
  await cloneTemplate(stack);
  process.env.DATABASE_URL = stack.databaseUrl;

  const delegate = startDelegate(stack);
  children.push(delegate);
  await waitForHttp(`${stack.delegateUrl}/health`, 60_000, 'The delegate', delegate);
  await waitForLiveDelegate(stack.databaseUrl, 60_000);
  await seedDatabase(stack.databaseUrl);
  recordChildren(stack);
}

function recordChildren(stack: Stack): void {
  mkdirSync(WORKERS_DIR, { recursive: true });
  writeFileSync(pidFile(stack.index), JSON.stringify(children.map((child) => child.pid)));
}

/**
 * Starts the file's server, once, on the first test's base URL. Every test
 * fixture runs after the file's beforeAll hooks, so the rows those hooks write
 * are in place before the server reads the org settings.
 */
async function ensureServer(stack: Stack): Promise<void> {
  if (serverUp) return;
  serverUp = true;
  const server = startServer(stack);
  children.push(server);
  await waitForHttp(`${stack.baseURL}/`, 120_000, 'The server', server);
  recordChildren(stack);
}

/**
 * Starts a fresh stack for the file that is about to run. Each spec file runs
 * `test.beforeAll(isolateFile)` before any of its own hooks, so no file's setup
 * sees the rows an earlier file left.
 */
export async function isolateFile({ stack }: { stack: Stack }): Promise<void> {
  await prepare(stack);
}

export const test = base.extend<
  { baseURL: string; page: import('@playwright/test').Page },
  { stack: Stack }
>({
  stack: [
    async ({}, use, workerInfo) => {
      const stack = readStack(workerInfo.parallelIndex);
      await reapPreviousWorker(stack.index);
      process.env.E2E_DELEGATE_URL = stack.delegateUrl;
      await use(stack);
      await stopChildren(stack.index);
    },
    // Starting the stack takes a while on a busy machine.
    { scope: 'worker', auto: true, timeout: 300_000 },
  ],
  baseURL: async ({ stack }, use) => {
    await use(stack.baseURL);
  },
  // A page is the first thing that needs the server, and no page is opened in a
  // hook: so the server starts after every beforeAll that writes the database.
  page: async ({ page, stack }, use) => {
    await ensureServer(stack);
    await use(page);
  },
});
