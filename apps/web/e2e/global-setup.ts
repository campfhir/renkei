/**
 * Runs once before the Playwright suite: seeds deterministic fixtures and
 * writes a storageState carrying the session cookie, so every test context
 * starts signed in without touching the (real, OIDC-only) login flow.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { seed, E2E_SESSION_ID, E2E_TENANT_ID } from './seed';

export const STORAGE_STATE_PATH = path.join(
  import.meta.dirname,
  '..',
  'test-results',
  'storage-state.json'
);

/**
 * A fresh dev server compiles an API route on its first hit, which can take
 * longer than a test's 5s expect timeout. chat.spec.ts's title-bar rename is
 * the first caller of the chat PATCH route, so it used to fail on a cold
 * server and pass on a warm one. A PATCH to a chat that does not exist
 * compiles the route and answers 404; the result is deliberately ignored.
 */
async function warmRoutes(): Promise<void> {
  const base = 'http://127.0.0.1:3000';
  const missingChat = '00000000-0000-4000-8000-000000000000';
  try {
    await fetch(`${base}/api/chat/chats/${missingChat}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `renkei_session=${E2E_SESSION_ID}`,
      },
      body: JSON.stringify({ title: 'warm-up' }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // Warming is best-effort; the tests still run, just cold.
  }
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set — playwright.config.ts should have loaded .env.development.'
    );
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Postgres is not reachable at ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}. ` +
        'Start it with `docker compose -f docker-compose.yml up -d postgres` at the repo root, ' +
        'then `pnpm --filter @renkei/db migrate`.',
      { cause: error }
    );
  }
  try {
    await seed(client);
  } finally {
    await client.end();
  }

  await warmRoutes();

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
