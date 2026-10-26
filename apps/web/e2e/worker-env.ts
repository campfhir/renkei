/**
 * Each Playwright worker gets its own database, delegate and dev server.
 *
 * The migrated template database (global-setup.ts) is cloned into
 * `renkei_e2e_w<N>` when the worker starts, so the worker seeds and writes
 * into a database no other worker touches. The worker then runs its own
 * delegate (the one process that registers against a database) and its own
 * `next dev` on a port of its own, and points `process.env.DATABASE_URL` at
 * its database so the specs' own clients connect there too.
 *
 * Specs opt in by importing `test` from here instead of '@playwright/test'.
 * The sandbox and MCP stubs stay shared: they hold no database state.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { test as base } from '@playwright/test';
import { seed } from './seed';

export const TEMPLATE_DATABASE = 'renkei_e2e_template';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const DEV_PORT_BASE = 3100;
const DELEGATE_PORT_BASE = 8200;

interface WorkerStack {
  baseURL: string;
  databaseUrl: string;
}

/** The database URL with its name swapped: the same server, another database. */
export function databaseUrlNamed(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Connects to the server's maintenance database, which can create and drop others. */
async function serverClient(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrlNamed(databaseUrl, 'postgres') });
  await client.connect();
  return client;
}

/** A clone of the template, from nothing: any earlier copy of this worker's database goes. */
async function cloneTemplate(databaseUrl: string, name: string): Promise<void> {
  const client = await serverClient(databaseUrl);
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
  } finally {
    await client.end();
  }
}

/** Polls until a URL answers, or fails after the deadline. */
async function waitForHttp(url: string, deadlineMs: number, label: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${label} did not answer at ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * The delegate answers HTTP before it has registered its instance, and seeding
 * needs the instance: so wait for a live row in this worker's own database.
 */
async function waitForLiveDelegate(databaseUrl: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (;;) {
      const live = await client.query(
        "SELECT 1 FROM delegate_instances WHERE heartbeat_at > NOW() - interval '2 minutes' LIMIT 1"
      );
      if ((live.rowCount ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('No delegate registered in this worker database.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await client.end();
  }
}

/** Starts a child process and keeps its output out of the test log unless it fails. */
function start(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string
): ChildProcess {
  // Output goes to a file a failing run can be read from, not into the test log.
  const out = openSync(logFile, 'w');
  // Its own process group: pnpm passes its signals on to nothing, so the group is stopped whole.
  return spawn(command, args, { cwd, env, stdio: ['ignore', out, out], detached: true });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const group = -child.pid;
  try {
    process.kill(group, 'SIGTERM');
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(group, 'SIGKILL');
      } catch {
        // Already gone.
      }
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Where a worker's child process writes its output. */
function workerLog(index: number, name: string): string {
  const dir = path.join(WEB_ROOT, 'test-results', 'workers');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `w${index}-${name}.log`);
}

/** The delegate's environment, as playwright.config.ts gives the shared one. */
function delegateEnv(databaseUrl: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DELEGATE_WORKER_API_KEY: 'e2e-delegate-key',
    DELEGATE_WORKER_PORT: String(port),
    BITBUCKET_API_BASE_URL: 'http://127.0.0.1:8092/bitbucket/2.0',
    JIRA_ADMIN_API_BASE_URL: 'http://127.0.0.1:8092/jira',
    JIRA_AUTOMATION_API_BASE_URL: 'http://127.0.0.1:8092/automation',
  };
}

/** The dev server's environment, as playwright.config.ts gives the shared one. */
function devEnv(databaseUrl: string, delegateUrl: string, index: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DELEGATE_WORKER_URL: delegateUrl,
    DELEGATE_WORKER_API_KEY: 'e2e-delegate-key',
    E2E_DIST_DIR: `.next-w${index}`,
    BITBUCKET_API_BASE_URL: 'http://127.0.0.1:8092/bitbucket/2.0',
    JIRA_ADMIN_API_BASE_URL: 'http://127.0.0.1:8092/jira',
    JIRA_AUTOMATION_API_BASE_URL: 'http://127.0.0.1:8092/automation',
    SETUP_SECRET: process.env.SETUP_SECRET ?? 'e2e-setup-secret',
  };
}

export const test = base.extend<{ baseURL: string }, { stack: WorkerStack }>({
  stack: [
    async ({}, use, workerInfo) => {
      const index = workerInfo.parallelIndex;
      const sharedUrl = process.env.DATABASE_URL;
      if (!sharedUrl) throw new Error('DATABASE_URL is not set for the worker.');
      const name = `renkei_e2e_w${index}`;
      const databaseUrl = databaseUrlNamed(sharedUrl, name);
      const port = DEV_PORT_BASE + index;
      const delegatePort = DELEGATE_PORT_BASE + index;
      const delegateUrl = `http://127.0.0.1:${delegatePort}`;

      await cloneTemplate(sharedUrl, name);
      process.env.DATABASE_URL = databaseUrl;

      // The delegate first: seeding enrolls the person's keys, which needs a live one.
      const delegate = start(
        'pnpm',
        ['--filter', '@renkei/worker-delegate', 'start'],
        WEB_ROOT,
        delegateEnv(databaseUrl, delegatePort),
        workerLog(index, 'delegate')
      );
      await waitForHttp(`${delegateUrl}/health`, 60_000, 'The delegate');
      await waitForLiveDelegate(databaseUrl, 60_000);

      const seedClient = new Client({ connectionString: databaseUrl });
      await seedClient.connect();
      try {
        await seed(seedClient);
      } finally {
        await seedClient.end();
      }

      const dev = start(
        'pnpm',
        ['exec', 'next', 'dev', '-p', String(port), '--hostname', '127.0.0.1'],
        WEB_ROOT,
        devEnv(databaseUrl, delegateUrl, index),
        workerLog(index, 'dev')
      );
      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, 180_000, 'The dev server');
        await use({ baseURL: `http://127.0.0.1:${port}`, databaseUrl });
      } finally {
        await stop(dev);
        await stop(delegate);
      }
    },
    // Starting the delegate and the dev server takes minutes on a busy machine.
    { scope: 'worker', auto: true, timeout: 300_000 },
  ],
  baseURL: async ({ stack }, use) => {
    await use(stack.baseURL);
  },
});

export { expect } from '@playwright/test';
