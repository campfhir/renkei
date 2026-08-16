import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';
import { HttpAdapter, type E2ESigningKeysJwk } from '@campfhir/bored-logs/adapters/http';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { getDatabase } from '@renkei/db';
import { resolveLogCipher } from './log-encryption';
import packageJson from '../package.json';

/**
 * The agents worker's logger — the same stack and env contract as
 * apps/worker's (console + Postgres/HTTP persistence, component attributes),
 * with THIS package's identity stamped on every row so a log line names
 * which process produced it. Structure mirrors apps/worker/src/logger.ts;
 * the two evolve together.
 */
const commit = process.env.GIT_COMMIT;
const version = commit ? `${packageJson.version}+${commit}` : packageJson.version;

export const logger = createLogger({
  application: packageJson.name,
  version,
  attributes: {
    application: packageJson.name,
    version,
    commit: commit ?? 'dev',
  },
});

logger.addAdapter(
  new ConsoleAdapter({
    level: process.env.CONSOLE_LOG_LEVEL ?? 'info',
    showTimestamp: true,
    showLevel: true,
    maskSecure: process.env.NODE_ENV === 'production',
  })
);

/** See apps/worker/src/logger.ts — same two shapes, chosen by LOG_SHIP_ENDPOINT. */
export async function attachPersistentLogging(): Promise<void> {
  const endpoint = process.env.LOG_SHIP_ENDPOINT;
  if (endpoint) {
    attachHttpShipping(endpoint);
    return;
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('Could not attach Postgres log adapter; logging to console only', {
      component: 'worker-agents/logging',
      error: String(dbResult.err),
    });
    return;
  }
  const cipherResult = resolveLogCipher();
  if (cipherResult.state === 'invalid') {
    logger.error('LOG_ENCRYPTION_KEY is malformed; secure log attributes stored UNENCRYPTED', {
      component: 'worker-agents/logging',
      error: cipherResult.error,
    });
  }
  const cipher = cipherResult.state === 'on' ? cipherResult.cipher : undefined;
  const adapter = new PostgresAdapter({
    db: dbResult.val,
    level: process.env.LOG_DB_LEVEL ?? 'info',
    ...(cipher ? { encrypt: cipher.encrypt, decrypt: cipher.decrypt } : {}),
  });
  try {
    await adapter.migrate();
  } catch (error) {
    logger.error('Log table migration failed; logging to console only', {
      component: 'worker-agents/logging',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  logger.addAdapter(adapter);
}

function attachHttpShipping(endpoint: string): void {
  const apiKey = process.env.LOG_SHIP_API_KEY;
  if (!apiKey) {
    logger.error('LOG_SHIP_ENDPOINT is set but LOG_SHIP_API_KEY is not; logging to console only', {
      component: 'worker-agents/logging',
      endpoint,
    });
    return;
  }

  const signingKeys = parseSigningKeys();

  const adapter = new HttpAdapter({
    endpoint,
    headers: { authorization: `Bearer ${apiKey}` },
    level: process.env.LOG_DB_LEVEL ?? 'info',
    useBeaconOnUnload: false,
    encryption: signingKeys
      ? { clientId: process.env.LOG_SHIP_CLIENT_ID ?? 'renkei-worker-agents', signingKeys }
      : {},
    onError: (err) => {
      // Raw console on purpose: logger.error here would enqueue the failure
      // report into this same adapter, which is currently failing.
      console.error('[worker-agents/log-ship] delivery failed', err);
    },
  });
  adapter.start();
  logger.addAdapter(adapter);
  logger.info('shipping logs to {endpoint} (e2e encrypted)', {
    component: 'worker-agents/logging',
    endpoint,
    identity: signingKeys ? 'persistent' : 'per-boot',
  });
}

/** LOG_SHIP_SIGNING_KEYS: the JWK pair `generate:log-ship-keys` prints. */
function parseSigningKeys(): E2ESigningKeysJwk | undefined {
  const raw = process.env.LOG_SHIP_SIGNING_KEYS;
  if (!raw) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const parsed = JSON.parse(raw) as E2ESigningKeysJwk;
    if (!parsed.publicJwk || !parsed.privateJwk) throw new Error('missing publicJwk/privateJwk');
    return parsed;
  } catch (error) {
    logger.error('LOG_SHIP_SIGNING_KEYS is malformed; using a per-boot identity: {error}', {
      component: 'worker-agents/logging',
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
