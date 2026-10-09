/**
 * The Renkei delegate — the one process that holds a key
 * (docs/delegate-key-design.md).
 *
 * Nothing here is derived. At boot this process generates an X25519
 * keypair and registers itself as a delegate instance; a signed-in
 * browser seals its person's user key (and their automation key, for the
 * window they chose) to that public key, and this process opens those
 * delegations, does the work, and drops the key. The web app and the
 * other workers reach it over bearer-authenticated HTTP and receive
 * exactly what the request they are serving needs: one resource's data
 * key, a value opened or sealed under a person's key, a provider's answer
 * with the token never leaving this process.
 *
 * Env contract:
 *   DELEGATE_WORKER_API_KEY  — required; comma-separated bearer keys the
 *     callers must present (rotation overlaps like LOG_SHIP_API_KEY).
 *   DELEGATE_WORKER_PORT     — listen port, default 8096.
 *   TOKEN_ENCRYPTION_KEY     — the org-wide secrets key: the OAuth client
 *     secrets in connector_configs that a token refresh needs.
 *   DATABASE_URL             — the shared Postgres: public keys, wrapped
 *     keys, delegations, resource keys, wrappings, grants.
 *   USER_KEY_ENCRYPTION_KEY  — OPTIONAL, migration only: the master that
 *     pre-enrollment (managed) keys were derived from. Needed while people
 *     who have not enrolled remain; `keys/census` says how many. Remove it
 *     once that count is zero. No other process reads it, and nothing but
 *     enrollment reads it here.
 */

import { getDatabase } from '@renkei/db';
import { enrollmentCensus, legacyMasterAvailable } from '@renkei/user-keys';
import { runWorker } from '@renkei/worker-kit';
import { createDelegateServer } from './server';
import { registerInstance } from './instance';
import { logger, attachPersistentLogging } from './logger';

void runWorker({
  name: 'worker-delegate',
  envPrefix: 'DELEGATE_WORKER',
  defaultPort: 8096,
  logger,
  attachPersistentLogging,
  createServer: ({ db, encryptionKey, apiKeys }) => {
    void registerInstance(db, logger)
      .then(async (instance) => {
        const retire = (): void => {
          void instance.retire();
        };
        process.once('SIGTERM', retire);
        process.once('SIGINT', retire);
        const census = await enrollmentCensus(db);
        const pending = census.managed + census.own;
        if (pending > 0 && !legacyMasterAvailable()) {
          logger.warn(
            '{pending} person(s) have not enrolled and USER_KEY_ENCRYPTION_KEY is unset: their enrollment cannot move their existing rows',
            { component: 'worker-delegate/instance', pending }
          );
        } else if (pending === 0 && legacyMasterAvailable()) {
          logger.info(
            'everyone has enrolled: USER_KEY_ENCRYPTION_KEY can be removed from this process',
            { component: 'worker-delegate/instance' }
          );
        }
      })
      .catch((error: unknown) => {
        console.error(
          `FATAL [worker-delegate]: could not register this instance: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      });
    return createDelegateServer({ db, encryptionKey, apiKeys, logger });
  },
});

// A boot without a database is already fatal in runWorker; this import
// keeps the census above honest about which pool it reads.
void getDatabase;
