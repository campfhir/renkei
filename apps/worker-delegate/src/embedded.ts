/**
 * The delegate inside another process: the same server, instance
 * registration and signing key index.ts boots, listening on a loopback
 * port of the host process's choosing. For the web app on the in-memory
 * data store (apps/web/lib/memory-delegate.ts), where the delegate has to
 * share the host's store — the memory store lives in one process — and
 * for nothing in a real deployment, which runs the delegate as its own
 * process (index.ts).
 */

import type { Server } from 'node:http';
import { createDelegateServer } from './server';
import { registerInstance } from './instance';
import { loadOrCreateSigningKey } from './signing';
import { silentDelegateLogger, type DelegateLogger } from './grants';

export interface EmbeddedDelegate {
  /** `http://127.0.0.1:<port>`: what the host's DELEGATE_WORKER_URL names. */
  url: string;
  /** Close the listener and retire the instance (its delegations go with it). */
  stop(): Promise<void>;
}

export async function startEmbeddedDelegate(options: {
  /** TOKEN_ENCRYPTION_KEY, parsed. */
  encryptionKey: Buffer;
  /** The one bearer key the host presents, as the `web` caller. */
  apiKey: string;
  /** The loopback port to listen on; 0 (the default) takes any free one. */
  port?: number;
  logger?: DelegateLogger;
}): Promise<EmbeddedDelegate> {
  const logger = options.logger ?? silentDelegateLogger;
  const signer = loadOrCreateSigningKey(options.encryptionKey, logger).catch((error: unknown) => {
    logger.error('the delegate signing key could not be loaded: {error}', {
      component: 'worker-delegate/signing',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  });
  const server: Server = createDelegateServer({
    encryptionKey: options.encryptionKey,
    apiKeys: [{ name: 'web', key: options.apiKey }],
    logger,
    signer,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the delegate has no port');
  const instance = await registerInstance(logger);
  await signer;
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await instance.retire();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
