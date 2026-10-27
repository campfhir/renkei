/**
 * The background workers a UI flow waits on, for a web server on the
 * in-memory data store (RENKEI_DATA_STORE=memory, the memory UI suite):
 * the agents worker's agent_jobs consumer — the run engine and the action
 * executor (apps/worker-agents/src/embedded.ts) — and the event
 * dispatcher (apps/worker/src/embedded.ts), started inside this process
 * because the memory store lives here and they must claim from the
 * queues this process's routes enqueue into. Each loop waits on the
 * store's queue notify, so a run starts the moment "Run now" enqueues it.
 *
 * Only the consumers: no sweeps, ingest or schedule loops. Tools run
 * through this server's own MCP endpoint, at RENKEI_WEB_INTERNAL_URL
 * (playwright.memory.config.ts names it) or this server's own port.
 *
 * Only instrumentation.ts calls this, and only on the memory store. A
 * deployment on Postgres runs each worker as its own process and never
 * reaches this module.
 */

import { getMemoryDataStore } from '@renkei/db';
import { startEmbeddedAgentsWorker } from '@renkei/worker-agents/embedded';
import { startEmbeddedEventDispatcher } from '@renkei/worker/embedded';
import { logger } from '@/lib/logger';

// register() re-runs on a dev recompile: one set of consumers per process.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalMarks = globalThis as unknown as { __renkeiMemoryWorkersStarted?: boolean };

function webBaseUrl(): string {
  const configured = process.env.RENKEI_WEB_INTERNAL_URL?.trim();
  return configured || `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

export function startMemoryWorkers(): void {
  if (globalMarks.__renkeiMemoryWorkersStarted) return;
  const store = getMemoryDataStore();
  if (!store) throw new Error('The in-process workers run on the memory data store only');
  globalMarks.__renkeiMemoryWorkersStarted = true;

  const url = webBaseUrl();
  startEmbeddedAgentsWorker({ webBaseUrl: url, wake: store.queueSignal('agent_jobs') });
  startEmbeddedEventDispatcher({ wake: store.queueSignal('events') });
  logger.warn('In-process agents worker and event dispatcher for the in-memory store ({url})', {
    component: 'web/memory-workers',
    url,
  });
}
