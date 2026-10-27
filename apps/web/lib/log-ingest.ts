import { createLogger } from '@campfhir/bored-logs';
import {
  createE2EServerContext,
  createLogIngestHandler,
  createLogRegistrationHandler,
  type E2EKeyPairJwk,
} from '@campfhir/bored-logs/server';
import { getDataStore } from '@renkei/db';
import { logger } from '@/lib/logger';
import type { LogCipher } from '@/lib/log-encryption';

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
  let store: ReturnType<typeof getDataStore>;
  try {
    store = getDataStore();
  } catch (error) {
    logger.error('Log shipping unavailable: no data store', {
      component: 'web/log-ingest',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  // A dedicated sink with ONLY the log-table adapter: shipped records are
  // already printed on their own application's console, so echoing them
  // through this app's ConsoleAdapter would double every line in
  // `docker logs`. ingest() preserves the shipper's application/version, so
  // this logger's own identity never stamps a shipped record.
  // Shipped secure() values arrive tagged and encrypt at rest here — the
  // shipper needs no key material (worker payload bodies included). Encryption
  // is mandatory: a missing or malformed key is fatal, never a silent plaintext
  // downgrade, so the process crashes rather than persisting bodies in the clear.
  const { requireLogCipher } = await import('@/lib/log-encryption');
  let cipher: LogCipher;
  try {
    cipher = requireLogCipher();
  } catch (error) {
    console.error(
      `FATAL [web/log-ingest]: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  const sink = createLogger({});
  sink.addAdapter(store.activityLogs.writer({ level: 'info', cipher }));

  const context = createE2EServerContext({
    // Durable registrations (migration 004_e2e_clients, applied by
    // adapter.migrate() at boot): shippers survive a server bounce without
    // re-registering, and multiple web instances share one registry.
    store: store.activityLogs.shippingRegistrations(),
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
