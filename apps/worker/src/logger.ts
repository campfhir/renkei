import { createLogger, ConsoleAdapter } from '@campfhir/bored-logs';
import { HttpAdapter, type E2ESigningKeysJwk } from '@campfhir/bored-logs/adapters/http';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { getDatabase } from '@renkei/db';
import packageJson from '../package.json';

/**
 * The worker's logger — same stack as the web app's (console + Postgres
 * adapters, component attributes), so worker activity finally lands in the
 * logs table beside everything else instead of only in docker logs. Identity
 * comes from this package's manifest, so rows say which worker version
 * produced them.
 *
 * A single-process CLI needs no globalThis anchor: one module graph, one
 * evaluation.
 */
export const logger = createLogger({
  application: packageJson.name,
  // GIT_COMMIT is baked in by docker-build.sh: every row names the exact
  // build that produced it (0.1.0+sha), absent in bare local runs.
  version: process.env.GIT_COMMIT
    ? `${packageJson.version}+${process.env.GIT_COMMIT}`
    : packageJson.version,
});

logger.addAdapter(
  new ConsoleAdapter({
    level: process.env.CONSOLE_LOG_LEVEL ?? 'info',
    showTimestamp: true,
    showLevel: true,
    maskSecure: process.env.NODE_ENV === 'production',
  })
);

/**
 * Attach the persistence adapter — called from main() at boot. Two shapes,
 * chosen by LOG_SHIP_ENDPOINT:
 *
 * - Set: ship over HTTP to the web app's /api/logs, end-to-end encrypted
 *   (bored-logs v1 suite: signed envelope, AES-256-GCM body) and
 *   authenticated with the shared LOG_SHIP_API_KEY bearer key. The worker
 *   stops writing the logs table itself — the web app is the single writer.
 * - Unset: the original same-box shape, a PostgresAdapter straight at the
 *   shared database.
 *
 * Failure is reported, not fatal: a worker that can log only to stdout still
 * beats one that refuses to start.
 */
export async function attachPersistentLogging(): Promise<void> {
  const endpoint = process.env.LOG_SHIP_ENDPOINT;
  if (endpoint) {
    attachHttpShipping(endpoint);
    return;
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('Could not attach Postgres log adapter; logging to console only', {
      component: 'worker/logging',
      error: String(dbResult.err),
    });
    return;
  }
  const adapter = new PostgresAdapter({
    db: dbResult.val,
    level: process.env.LOG_DB_LEVEL ?? 'info',
  });
  try {
    // Idempotent (CREATE IF NOT EXISTS) — safe on every boot, and what keeps
    // the log tables current across bored-logs upgrades.
    await adapter.migrate();
  } catch (error) {
    logger.error('Log table migration failed; logging to console only', {
      component: 'worker/logging',
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
      component: 'worker/logging',
      endpoint,
    });
    return;
  }

  // A persistent signing identity keeps one pinned registration row across
  // restarts. Without it the adapter mints a fresh clientId per boot — still
  // correct (pinning never conflicts), just one registry row per boot.
  const signingKeys = parseSigningKeys();

  const adapter = new HttpAdapter({
    endpoint,
    headers: { authorization: `Bearer ${apiKey}` },
    level: process.env.LOG_DB_LEVEL ?? 'info',
    useBeaconOnUnload: false,
    // Registration happens at `<endpoint>/register` (the adapter's default).
    // The default id is NOT packageJson.name: client ids are restricted to
    // [A-Za-z0-9._:-], and `@renkei/worker` fails on both @ and /.
    encryption: signingKeys
      ? { clientId: process.env.LOG_SHIP_CLIENT_ID ?? 'renkei-worker', signingKeys }
      : {},
    onError: (err) => {
      // Raw console on purpose: logger.error here would enqueue the failure
      // report into this same adapter, which is currently failing — a
      // feedback loop for the length of any outage.
      console.error('[worker/log-ship] delivery failed', err);
    },
  });
  // start() runs the periodic flush timer; without it batches would only
  // leave when batchSize fills, which on a quiet worker is never.
  adapter.start();
  logger.addAdapter(adapter);
  logger.info('shipping logs to {endpoint} (e2e encrypted)', {
    component: 'worker/logging',
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
      component: 'worker/logging',
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
