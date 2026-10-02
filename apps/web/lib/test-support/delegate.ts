/**
 * The delegate, in-process, for the database tests: the web app only ever
 * reaches it over HTTP, so a test starts the real server on a loopback
 * port and points the process-wide client at it. Tests then exercise the
 * same wire the app uses, against the same database.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { createDelegateServer } from '@renkei/worker-delegate';
import {
  DelegateClient,
  DelegateGrants,
  DelegateTransport,
  setDelegateClient,
  setDelegateGrants,
} from '@renkei/delegate-client';

/**
 * Register the delegate for the describe block this is called in: started
 * in its beforeAll against the pool `getDatabase()` hands out THEN (a
 * sibling block's afterAll may have closed an earlier one), stopped in its
 * afterAll.
 */
export function useTestDelegate(): void {
  let started: TestDelegate | null = null;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    const db = getDatabase();
    if (db.ok) started = await startTestDelegate(db.val);
  });
  afterAll(async () => {
    await started?.stop();
    started = null;
  });
}

export interface TestDelegate {
  url: string;
  apiKey: string;
  stop(): Promise<void>;
}

export async function startTestDelegate(
  db: Kysely<DB>,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<TestDelegate> {
  process.env.USER_KEY_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  const tokenKey = parseEncryptionKey(
    process.env.TOKEN_ENCRYPTION_KEY || randomBytes(32).toString('base64')
  );
  if (!tokenKey.ok) throw new Error('TOKEN_ENCRYPTION_KEY is malformed');
  const apiKey = `test-${randomBytes(8).toString('hex')}`;
  const server: Server = createDelegateServer({
    db,
    encryptionKey: tokenKey.val,
    apiKeys: [apiKey],
    fetchImpl: options.fetchImpl,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${(address satisfies AddressInfo).port}`;
  const config = { url, apiKey };
  setDelegateClient(new DelegateClient(new DelegateTransport(config)));
  setDelegateGrants(new DelegateGrants(new DelegateTransport(config), url, apiKey));
  return {
    url,
    apiKey,
    stop: async () => {
      setDelegateClient(null);
      setDelegateGrants(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
