/**
 * The per-worker stack: a database cloned from the migrated template, the
 * delegate that registers against it, and the app server (`next start` on the
 * one production build) pointed at both.
 *
 * Global setup builds the app once and writes the manifest of stacks. Each
 * worker starts its own delegate and server, and before every test file it
 * clones its database afresh and seeds it, so no file sees rows another file
 * left. Restarting the server and delegate with the database matters: both
 * hold state in memory that a new database would leave stale.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { seed } from './seed';
import { forgetEnrollments } from './keys';
import { E2E_SETUP_SECRET } from './setup-secret';

export const TEMPLATE_DATABASE = 'renkei_e2e_template';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const RESULTS = path.join(WEB_ROOT, 'test-results');
const WORKERS_DIR = path.join(RESULTS, 'workers');
const MANIFEST = path.join(RESULTS, 'stacks.json');
const BUILD_DIR = '.next-e2e';
const SERVER_PORT_BASE = 3100;
const DELEGATE_PORT_BASE = 8200;

export interface Stack {
  index: number;
  /** The shared server's database, which the template and the other stacks live beside. */
  sharedUrl: string;
  name: string;
  databaseUrl: string;
  baseURL: string;
  delegateUrl: string;
}

/** The database URL with its name swapped: the same server, another database. */
export function databaseUrlNamed(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The stack for a worker, from the manifest global setup wrote. */
export function readStack(index: number): Stack {
  const stacks: Stack[] = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const stack = stacks.find((candidate) => candidate.index === index);
  if (!stack) throw new Error(`No stack was planned for worker ${index}.`);
  return stack;
}

/** The manifest of stacks, one per worker, with their ports and databases. */
export function writeManifest(sharedUrl: string, count: number): void {
  mkdirSync(RESULTS, { recursive: true });
  const stacks: Stack[] = Array.from({ length: count }, (_, index) => {
    const name = `renkei_e2e_w${index}`;
    return {
      index,
      sharedUrl,
      name,
      databaseUrl: databaseUrlNamed(sharedUrl, name),
      baseURL: `http://127.0.0.1:${SERVER_PORT_BASE + index}`,
      delegateUrl: `http://127.0.0.1:${DELEGATE_PORT_BASE + index}`,
    };
  });
  writeFileSync(MANIFEST, JSON.stringify(stacks, null, 2));
}

/**
 * One production build of the app, shared by every stack. E2E_SKIP_BUILD reuses
 * the build already in place.
 */
export async function buildApp(): Promise<void> {
  if (process.env.E2E_SKIP_BUILD) return;
  mkdirSync(WORKERS_DIR, { recursive: true });
  const out = openSync(path.join(WORKERS_DIR, 'build.log'), 'w');
  // The build rewrites tsconfig.json with its own build directories: put it back.
  const tsconfig = path.join(WEB_ROOT, 'tsconfig.json');
  const savedTsconfig = readFileSync(tsconfig, 'utf8');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'next', 'build'], {
      cwd: WEB_ROOT,
      env: { ...process.env, E2E_DIST_DIR: BUILD_DIR },
      stdio: ['ignore', out, out],
    });
    child.once('exit', (code) => {
      writeFileSync(tsconfig, savedTsconfig);
      if (code === 0) resolve();
      else
        reject(new Error(`next build failed (exit ${code}); see test-results/workers/build.log`));
    });
  });
}

/** Starts a child process; its output goes to a file a failing run can be read from. */
export function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logFile: string
): ChildProcess {
  mkdirSync(WORKERS_DIR, { recursive: true });
  const out = openSync(logFile, 'w');
  // Its own process group: pnpm passes its signals on to nothing, so the group is stopped whole.
  return spawn(command, args, { cwd: WEB_ROOT, env, stdio: ['ignore', out, out], detached: true });
}

export async function stop(child: ChildProcess): Promise<void> {
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
export async function waitForHttp(url: string, deadlineMs: number, label: string): Promise<void> {
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
export async function waitForLiveDelegate(databaseUrl: string, deadlineMs: number): Promise<void> {
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
export async function cloneTemplate(stack: Stack): Promise<void> {
  const client = new Client({ connectionString: databaseUrlNamed(stack.sharedUrl, 'postgres') });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${stack.name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${stack.name} TEMPLATE ${TEMPLATE_DATABASE}`);
  } finally {
    await client.end();
  }
}

/** The stack's delegate, registered against its database. */
export function startDelegate(stack: Stack): ChildProcess {
  return start(
    'pnpm',
    ['--filter', '@renkei/worker-delegate', 'start'],
    {
      ...process.env,
      DATABASE_URL: stack.databaseUrl,
      DELEGATE_WORKER_API_KEY: 'e2e-delegate-key',
      DELEGATE_WORKER_PORT: String(new URL(stack.delegateUrl).port),
      BITBUCKET_API_BASE_URL: 'http://127.0.0.1:8092/bitbucket/2.0',
      JIRA_ADMIN_API_BASE_URL: 'http://127.0.0.1:8092/jira',
      JIRA_AUTOMATION_API_BASE_URL: 'http://127.0.0.1:8092/automation',
    },
    path.join(WORKERS_DIR, `w${stack.index}-delegate.log`)
  );
}

/** The stack's app server: `next start` on the shared build, against its database and delegate. */
export function startServer(stack: Stack): ChildProcess {
  return start(
    'pnpm',
    ['exec', 'next', 'start', '-p', String(new URL(stack.baseURL).port), '--hostname', '127.0.0.1'],
    {
      ...process.env,
      DATABASE_URL: stack.databaseUrl,
      DELEGATE_WORKER_URL: stack.delegateUrl,
      DELEGATE_WORKER_API_KEY: 'e2e-delegate-key',
      E2E_DIST_DIR: BUILD_DIR,
      BITBUCKET_API_BASE_URL: 'http://127.0.0.1:8092/bitbucket/2.0',
      JIRA_ADMIN_API_BASE_URL: 'http://127.0.0.1:8092/jira',
      JIRA_AUTOMATION_API_BASE_URL: 'http://127.0.0.1:8092/automation',
      // The same secret the first-run setup spec presents (playwright.config.ts).
      SETUP_SECRET: E2E_SETUP_SECRET,
      // File storage: the local blob store, so uploads and the composer's paperclip work.
      BLOB_STORE_PROVIDER: process.env.BLOB_STORE_PROVIDER ?? 'local',
      BLOB_STORE_LOCAL_DIR: process.env.BLOB_STORE_LOCAL_DIR ?? path.join(RESULTS, 'blobs'),
    },
    path.join(WORKERS_DIR, `w${stack.index}-server.log`)
  );
}

/** Seeds a stack's fresh database. Enrollments are forgotten first: the cache is per process. */
export async function seedDatabase(databaseUrl: string): Promise<void> {
  forgetEnrollments();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await seed(client);
  } finally {
    await client.end();
  }
}
