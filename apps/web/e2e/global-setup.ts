/**
 * Runs once before the Playwright suite: seeds deterministic fixtures and
 * writes a storageState carrying the session cookie, so every test context
 * starts signed in without touching the (real, OIDC-only) login flow.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { E2E_SESSION_ID } from './seed';
import { TEMPLATE_DATABASE, buildApp, databaseUrlNamed, writeManifest } from './stacks';

export const STORAGE_STATE_PATH = path.join(
  import.meta.dirname,
  '..',
  'test-results',
  'storage-state.json'
);

/**
 * The migrated template every worker clones (worker-env.ts). Created when it is
 * missing and migrated on every run, which applies only what is new. It is made
 * from an empty database rather than the shared one, which the shared dev
 * server holds open.
 */
async function ensureTemplate(databaseUrl: string): Promise<void> {
  const admin = new Client({ connectionString: databaseUrlNamed(databaseUrl, 'postgres') });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEMPLATE_DATABASE,
    ]);
    if (found.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
    }
  } finally {
    await admin.end();
  }
  execFileSync('pnpm', ['--filter', '@renkei/db', 'migrate'], {
    cwd: path.join(import.meta.dirname, '..', '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrlNamed(databaseUrl, TEMPLATE_DATABASE) },
    stdio: 'inherit',
  });
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set — playwright.config.ts should have loaded .env.development.'
    );
  }

  await ensureTemplate(databaseUrl);
  await buildApp();
  // Each worker's stack is planned here and started by the worker (worker-env.ts).
  writeManifest(databaseUrl, Number(process.env.E2E_WORKERS ?? 3));

  // The cookie is the whole credential: an opaque session id (lib/session.ts).
  mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  writeFileSync(
    STORAGE_STATE_PATH,
    JSON.stringify(
      {
        cookies: [
          {
            name: `renkei_session`,
            value: E2E_SESSION_ID,
            domain: '127.0.0.1',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      null,
      2
    )
  );
}
