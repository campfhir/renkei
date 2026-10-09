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
 *   DELEGATE_WORKER_API_KEYS — the bearer key of each calling process, as
 *     `web=…,worker=…,agents=…` (callers.ts says what each may do). A name
 *     may repeat for a rotation overlap.
 *   DELEGATE_WORKER_API_KEY  — the one-shared-key form from before: comma-
 *     separated keys that all count as the `web` caller. One of the two is
 *     required; the development default is refused under NODE_ENV=production.
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
import { CALLER_OPS, developmentKeyRefusal } from './callers';
import { standInViolations } from './providers';
import { loadOrCreateSigningKey } from './signing';

// A provider stand-in (GITHUB_API_BASE_URL and friends) lets a person's
// token travel to an arbitrary origin over plain HTTP. That is for the
// e2e stub and nothing else: in production the process does not start.
const standIns = standInViolations();
if (standIns.length > 0) {
  console.error(
    `FATAL [worker-delegate]: ${standIns.join(', ')} ${standIns.length === 1 ? 'is' : 'are'} set with NODE_ENV=production. ` +
      'Provider stand-ins route tokens to a non-provider origin and are refused in production; unset them.'
  );
  process.exit(1);
}

void runWorker({
  name: 'worker-delegate',
  envPrefix: 'DELEGATE_WORKER',
  defaultPort: 8096,
  // The plain DELEGATE_WORKER_API_KEY is the web app's: the one caller
  // that may run everything, which is what every key could do before.
  defaultCallerName: 'web',
  logger,
  attachPersistentLogging,
  createServer: ({ db, encryptionKey, apiKeys, namedApiKeys }) => {
    const refusal = developmentKeyRefusal(apiKeys);
    if (refusal) {
      console.error(`FATAL [worker-delegate]: ${refusal}`);
      process.exit(1);
    }
    for (const entry of namedApiKeys) {
      if (!Object.prototype.hasOwnProperty.call(CALLER_OPS, entry.name)) {
        logger.warn(
          'DELEGATE_WORKER_API_KEYS names the caller {caller}, which callers.ts does not know: that key may run nothing',
          { component: 'worker-delegate/server', caller: entry.name }
        );
      }
    }
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
    // The deployment's signing key: made on the first boot, read on every
    // later one, so a browser can accept a new instance's key on its say-so.
    const signer = loadOrCreateSigningKey(db, encryptionKey, logger).catch((error: unknown) => {
      logger.error('the delegate signing key could not be loaded: {error}', {
        component: 'worker-delegate/signing',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    return createDelegateServer({ db, encryptionKey, apiKeys: namedApiKeys, logger, signer });
  },
});

// A boot without a database is already fatal in runWorker; this import
// keeps the census above honest about which pool it reads.
void getDatabase;
