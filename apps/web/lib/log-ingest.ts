import { createLogger } from '@campfhir/bored-logs';
import {
  createE2EServerContext,
  createLogIngestHandler,
  createLogRegistrationHandler,
  type E2EKeyPairJwk,
} from '@campfhir/bored-logs/server';
import type { Kysely } from 'kysely';
import type { LoggerTables } from '@campfhir/bored-logs/adapters/psql';
import { getDatabase } from '@renkei/db';
import { logger } from '@/lib/logger';

/**
 * The server half of e2e-encrypted log shipping: other applications (the
 * worker first) POST their logs to /api/logs, sealed with the bored-logs v1
 * suite (ECDH P-256 → AES-256-GCM body, ECDSA-signed envelope), and they land
 * in the same logs table the viewer reads — each record keeping its shipper's
 * application/version identity.
 *
 * One shared E2E context feeds both handlers (ingest verifies/decrypts with
 * the key material registration stored), so the pair is built together and
 * anchored on globalThis — the same multi-graph reality that motivates the
 * logger anchor applies to any module the routes share.
 *
 * Encryption is REQUIRED: this endpoint exists for e2e shipping, so a
 * plaintext POST is a misconfigured shipper, answered 400 rather than
 * silently accepted.
 */
type LogShippingHandlers = {
  ingest: (request: Request) => Promise<Response>;
  register: (request: Request) => Promise<Response>;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForLogShipping = globalThis as unknown as {
  __renkeiLogShipping?: Promise<LogShippingHandlers | null>;
};

export function getLogShipping(): Promise<LogShippingHandlers | null> {
  return (globalForLogShipping.__renkeiLogShipping ??= build());
}

async function build(): Promise<LogShippingHandlers | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('Log shipping unavailable: no database', {
      component: 'web/log-ingest',
      error: String(dbResult.err),
    });
    return null;
  }

  // Dynamic import for the same reason instrumentation.ts uses one: the psql
  // adapter reaches ESM-only kysely helpers that must stay out of graphs
  // (jest, client) that can't parse them.
  const { PostgresAdapter, PsqlE2ERegistrationStore } =
    await import('@campfhir/bored-logs/adapters/psql');

  // A dedicated sink with ONLY the Postgres adapter: shipped records are
  // already printed on their own application's console, so echoing them
  // through this app's ConsoleAdapter would double every line in
  // `docker logs`. ingest() preserves the shipper's application/version, so
  // this logger's own identity never stamps a shipped record.
  const sink = createLogger({});
  sink.addAdapter(
    new PostgresAdapter({
      db: dbResult.val,
      level: process.env.LOG_DB_LEVEL ?? 'info',
    })
  );

  const context = createE2EServerContext({
    // Durable registrations (migration 004_e2e_clients, applied by
    // adapter.migrate() at boot): shippers survive a server bounce without
    // re-registering, and multiple web instances share one registry. The
    // store is typed against the bored-logs tables, which live in this same
    // database — hence the cast.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    store: new PsqlE2ERegistrationStore(dbResult.val as unknown as Kysely<LoggerTables>),
    keys: parseServerKeys(),
  });

  const { authorizeLogShipment } = await import('@/lib/log-ship-auth');
  const onError = (err: unknown) => {
    logger.error('log shipping handler error: {error}', {
      component: 'web/log-ingest',
      error: err instanceof Error ? err.message : String(err),
    });
  };

  return {
    ingest: createLogIngestHandler({
      logger: sink,
      authorize: authorizeLogShipment,
      encryption: { context, required: true },
      onError,
    }),
    register: createLogRegistrationHandler(context, {
      authorize: authorizeLogShipment,
      onError,
    }),
  };
}

/**
 * The server's static ECDH keypair, from LOG_E2E_SERVER_KEYS (the JSON that
 * `pnpm --filter renkei generate:log-ship-keys` prints). Absent, a fresh pair
 * is generated per boot — correct but noisier: every restart makes shippers
 * hit `decrypt-failed` once and transparently re-register.
 */
function parseServerKeys(): E2EKeyPairJwk | undefined {
  const raw = process.env.LOG_E2E_SERVER_KEYS;
  if (!raw) {
    logger.info(
      'LOG_E2E_SERVER_KEYS not set; using per-boot server keys (shippers re-register after each restart)',
      {
        component: 'web/log-ingest',
      }
    );
    return undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const parsed = JSON.parse(raw) as E2EKeyPairJwk;
    if (!parsed.publicJwk || !parsed.privateJwk) throw new Error('missing publicJwk/privateJwk');
    return parsed;
  } catch (error) {
    logger.error('LOG_E2E_SERVER_KEYS is malformed; using per-boot server keys: {error}', {
      component: 'web/log-ingest',
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
