/**
 * Runs once per memory-suite run, after the server is up
 * (playwright.memory.config.ts): writes e2e/seed.ts's shared fixtures
 * through store calls (./fixtures.ts) and a storageState carrying the
 * shared person's session cookie. A spec that reads those fixtures signs
 * in with `test.use({ storageState: SHARED_STORAGE_STATE })`; a spec that
 * writes gets a person of its own instead (e2e/memory/fixtures.ts).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { request } from '@playwright/test';
import { E2E_SESSION_ID, seedSharedFixtures } from './fixtures';

export const SHARED_STORAGE_STATE = path.join(
  import.meta.dirname,
  '..',
  '..',
  'test-results',
  'memory',
  'storage-state.json'
);

export default async function globalSetup(): Promise<void> {
  const context = await request.newContext();
  try {
    await seedSharedFixtures(context);
  } finally {
    await context.dispose();
  }

  mkdirSync(path.dirname(SHARED_STORAGE_STATE), { recursive: true });
  writeFileSync(
    SHARED_STORAGE_STATE,
    JSON.stringify(
      {
        cookies: [
          {
            name: 'renkei_session',
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
