/**
 * The Renkei delegate — the one process that holds a key
 * (docs/delegate-key-design.md).
 *
 * Every person's key-encryption key is derived, and every resource key
 * unwrapped, HERE and nowhere else. The web app and the other workers
 * reach it over bearer-authenticated HTTP and receive exactly what the
 * request they are serving needs: one resource's data key, a value opened
 * or sealed under a person's key, a provider's answer with the token
 * never leaving this process. No other process reads
 * USER_KEY_ENCRYPTION_KEY.
 *
 * Env contract:
 *   DELEGATE_WORKER_API_KEY  — required; comma-separated bearer keys the
 *     callers must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   DELEGATE_WORKER_PORT     — listen port, default 8096.
 *   USER_KEY_ENCRYPTION_KEY  — required; the master every managed
 *     key-encryption key is derived from. Set on THIS process only.
 *   TOKEN_ENCRYPTION_KEY     — the org-wide secrets key: the OAuth client
 *     secrets in connector_configs that a token refresh needs.
 *   DATABASE_URL             — the shared Postgres: salts, resource keys,
 *     wrappings, grants.
 */

import { userKeyMaster } from '@renkei/crypto';
import { runWorker } from '@renkei/worker-kit';
import { createDelegateServer } from './server';
import { logger, attachPersistentLogging } from './logger';

// Checked before the port opens: a delegate that cannot derive a key has
// nothing to offer, and the failure should read as configuration, not as
// every request answering MISSING_USER_KEY_MASTER.
const master = userKeyMaster();
if (!master.ok) {
  console.error(`FATAL [worker-delegate]: ${master.err.message ?? master.err.type}`);
  process.exit(1);
}

void runWorker({
  name: 'worker-delegate',
  envPrefix: 'DELEGATE_WORKER',
  defaultPort: 8096,
  logger,
  attachPersistentLogging,
  createServer: ({ db, encryptionKey, apiKeys }) =>
    createDelegateServer({ db, encryptionKey, apiKeys }),
});
