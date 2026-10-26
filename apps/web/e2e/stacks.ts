/**
 * One stack per worker, started once for the whole run.
 *
 * A stack is a database cloned from the migrated template, the delegate that
 * registers against it, and a `next dev` pointed at both. Global setup starts
 * one per worker and writes their addresses to a manifest; each worker reads
 * its own entry (worker-env.ts). A worker that restarts after a failed test then
 * only reconnects, instead of booting a dev server again.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { E2E_SESSION_ID, seed } from './seed';

export const TEMPLATE_DATABASE = 'renkei_e2e_template';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const RESULTS = path.join(WEB_ROOT, 'test-results');
const MANIFEST = path.join(RESULTS, 'stacks.json');
const BUILD_DIR = '.next-e2e';
const DEV_PORT_BASE = 3100;
const DELEGATE_PORT_BASE = 8200;

export interface Stack {
  index: number;
  baseURL: string;
  databaseUrl: string;
  delegateUrl: string;
}

/** The database URL with its name swapped: the same server, another database. */
export function databaseUrlNamed(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The stack a worker was given, by its index. */
export function readStack(index: number): Stack {
  const stacks: Stack[] = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const stack = stacks.find((candidate) => candidate.index === index);
  if (!stack) throw new Error(`No stack was started for worker ${index}.`);
  return stack;
}

/** Starts a child process; its output goes to a file a failing run can be read from. */
function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logFile: string
): ChildProcess {
  const out = openSync(logFile, 'w');
  // Its own process group: pnpm passes its signals on to nothing, so the group is stopped whole.
  return spawn(command, args, { cwd: WEB_ROOT, env, stdio: ['ignore', out, out], detached: true });
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
 * needs the instance: so wait for a live row in the stack's own database.
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
      if (Date.now() > deadline) throw new Error('No delegate registered in this database.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await client.end();
  }
}

/** A clone of the template: any earlier copy of this stack's database goes. */
async function cloneTemplate(sharedUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrlNamed(sharedUrl, 'postgres') });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
  } finally {
    await client.end();
  }
}

/** Starts one stack: clone, delegate, seed, dev server. */
async function startStack(
  sharedUrl: string,
  index: number
): Promise<{ stack: Stack; children: ChildProcess[] }> {
  const name = `renkei_e2e_w${index}`;
  const databaseUrl = databaseUrlNamed(sharedUrl, name);
  const port = DEV_PORT_BASE + index;
  const delegatePort = DELEGATE_PORT_BASE + index;
  const delegateUrl = `http://127.0.0.1:${delegatePort}`;
  const logs = path.join(RESULTS, 'workers');
  mkdirSync(logs, { recursive: true });

  await cloneTemplate(sharedUrl, name);

  const delegateEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DELEGATE_WORKER_API_KEY: 'e2e-delegate-key',
    DELEGATE_WORKER_PORT: String(delegatePort),
    BITBUCKET_API_BASE_URL: 'http://127.0.0.1:8092/bitbucket/2.0',
    JIRA_ADMIN_API_BASE_URL: 'http://127.0.0.1:8092/jira',
    JIRA_AUTOMATION_API_BASE_URL: 'http://127.0.0.1:8092/automation',
  };
  // The delegate first: seeding enrolls the person's keys, which needs a live one.
  const children: ChildProcess[] = [];
  try {
    const delegate = start(
      'pnpm',
      ['--filter', '@renkei/worker-delegate', 'start'],
      delegateEnv,
      path.join(logs, `w${index}-delegate.log`)
    );
    children.push(delegate);
    await waitForHttp(`${delegateUrl}/health`, 60_000, 'The delegate');
    await waitForLiveDelegate(databaseUrl, 60_000);

    const seedClient = new Client({ connectionString: databaseUrl });
    await seedClient.connect();
    try {
      await seed(seedClient);
    } finally {
      await seedClient.end();
    }

    const devEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DELEGATE_WORKER_URL: delegateUrl,
      DELEGATE_WORKER_API_KEY: 'e2e-delegate-key',
      E2E_DIST_DIR: BUILD_DIR,
      BITBUCKET_API_BASE_URL: 'http://127.0.0.1:8092/bitbucket/2.0',
      JIRA_ADMIN_API_BASE_URL: 'http://127.0.0.1:8092/jira',
      JIRA_AUTOMATION_API_BASE_URL: 'http://127.0.0.1:8092/automation',
      SETUP_SECRET: process.env.SETUP_SECRET ?? 'e2e-setup-secret',
    };
    const dev = start(
      'pnpm',
      ['exec', 'next', 'start', '-p', String(port), '--hostname', '127.0.0.1'],
      devEnv,
      path.join(logs, `w${index}-server.log`)
    );
    children.push(dev);
    const baseURL = `http://127.0.0.1:${port}`;
    // Three cold compiles at once take minutes; later runs reuse each stack's build cache.
    await waitForHttp(`${baseURL}/`, 120_000, 'The server');
    return { stack: { index, baseURL, databaseUrl, delegateUrl }, children };
  } catch (error) {
    await Promise.all(children.map(stop));
    throw error;
  }
}

/**
 * One production build of the app, shared by every stack. Each stack then runs
 * `next start` on it, so no stack compiles anything on a first visit.
 * E2E_SKIP_BUILD reuses the build already in place.
 */
async function buildApp(): Promise<void> {
  mkdirSync(path.join(RESULTS, 'workers'), { recursive: true });
  const out = openSync(path.join(RESULTS, 'workers', 'build.log'), 'w');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'next', 'build'], {
      cwd: WEB_ROOT,
      env: { ...process.env, E2E_DIST_DIR: BUILD_DIR },
      stdio: ['ignore', out, out],
    });
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`next build failed (exit ${code}); see test-results/workers/build.log`))
    );
  });
}

/**
 * Starts a stack for each worker and writes the manifest. The returned function
 * stops them all, and restores tsconfig.json, which `next dev` rewrites with
 * the per-stack build directories it adds.
 */
export async function startStacks(sharedUrl: string, count: number): Promise<() => Promise<void>> {
  const tsconfig = path.join(WEB_ROOT, 'tsconfig.json');
  const savedTsconfig = readFileSync(tsconfig, 'utf8');
  mkdirSync(RESULTS, { recursive: true });

  // Playwright does not run the teardown when setup throws, so a failed start
  // stops whatever it had already started before the error goes up.
  const started: { stack: Stack; children: ChildProcess[] }[] = [];
  const stopAll = async () => {
    await Promise.all(started.flatMap((entry) => entry.children.map(stop)));
    writeFileSync(tsconfig, savedTsconfig);
  };
  try {
    if (!process.env.E2E_SKIP_BUILD) await buildApp();
    const settled = await Promise.allSettled(
      Array.from({ length: count }, (_, index) => startStack(sharedUrl, index))
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') started.push(result.value);
    }
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } catch (error) {
    await stopAll();
    throw error;
  }
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      started.map((entry) => entry.stack),
      null,
      2
    )
  );

  return stopAll;
}
