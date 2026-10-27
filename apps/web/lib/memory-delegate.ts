/**
 * The delegate for a web server on the in-memory data store
 * (RENKEI_DATA_STORE=memory, the memory UI suite): the real delegate
 * server (apps/worker-delegate/src/embedded.ts) started inside this
 * process on a loopback port, because the memory store lives in this
 * process and the delegate has to read and write the same rows the pages
 * do. The app then reaches it exactly as a deployment reaches its own
 * delegate — over HTTP, at DELEGATE_WORKER_URL with
 * DELEGATE_WORKER_API_KEY — so key enrollment, chat keys and provider
 * grants all run for real.
 *
 * The environment names where it listens and the key it accepts
 * (playwright.memory.config.ts passes a loopback URL, a key and
 * TOKEN_ENCRYPTION_KEY). Whatever it leaves out is made up here and
 * written back to process.env — but a dev server is best given all three:
 * `next dev` notices an environment that changed under it and rebuilds
 * (and reloads every open page) on the next compile.
 *
 * Only instrumentation.ts calls this, and only on the memory store. A
 * deployment on Postgres runs the delegate as its own process and never
 * reaches this module.
 */

import { randomBytes } from 'node:crypto';
import { parseEncryptionKey } from '@renkei/crypto';
import { startEmbeddedDelegate } from '@renkei/worker-delegate/embedded';
import { logger } from '@/lib/logger';

// register() re-runs on a dev recompile: one delegate per process.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalMarks = globalThis as unknown as { __renkeiMemoryDelegateUrl?: string };

/** A loopback port named by DELEGATE_WORKER_URL, or 0 (any free one) when it names none. */
function configuredPort(url: string | undefined): number {
  if (!url) return 0;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (!parsed || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port) return 0;
  return Number(parsed.port);
}

export async function startMemoryDelegate(): Promise<void> {
  if (globalMarks.__renkeiMemoryDelegateUrl) return;

  // The org-wide secrets key seals connector secrets on the app side and
  // opens them on the delegate's: one value for both.
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  const encryptionKey = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!encryptionKey.ok) throw new Error('TOKEN_ENCRYPTION_KEY is malformed');

  const configuredKey = process.env.DELEGATE_WORKER_API_KEY?.trim();
  const apiKey = configuredKey || `memory-${randomBytes(16).toString('hex')}`;
  const component = 'web/memory-delegate';
  const delegate = await startEmbeddedDelegate({
    encryptionKey: encryptionKey.val,
    apiKey,
    port: configuredPort(process.env.DELEGATE_WORKER_URL),
    // Warnings and errors only: the delegate logs every op at info, and
    // `next dev` writes each server line into .next/dev/logs — a line per
    // request a page makes is noise here (the access record itself is
    // still kept, in delegate_access_events).
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message, context) => logger.warn(message, { component, ...context }),
      error: (message, context) => logger.error(message, { component, ...context }),
    },
  });
  // Read lazily by @renkei/delegate-client on its first call, in whichever
  // compilation graph makes it; written only when they differ.
  if (process.env.DELEGATE_WORKER_URL !== delegate.url) {
    process.env.DELEGATE_WORKER_URL = delegate.url;
  }
  if (!configuredKey) process.env.DELEGATE_WORKER_API_KEY = apiKey;
  if (process.env.DELEGATE_WORKER_CALLER) delete process.env.DELEGATE_WORKER_CALLER;
  globalMarks.__renkeiMemoryDelegateUrl = delegate.url;
  logger.warn('In-process delegate for the in-memory store listening on {url}', {
    component,
    url: delegate.url,
  });
}
