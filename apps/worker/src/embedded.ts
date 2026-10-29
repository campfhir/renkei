/**
 * The event dispatcher inside another process: the events-queue consumer
 * with every handler index.ts registers, running on the host's event
 * loop. For the web app on the in-memory data store
 * (apps/web/lib/memory-workers.ts), where the memory store lives in one
 * process and the consumer has to claim from the queue the web app's
 * routes enqueue into; for nothing in a real deployment, which runs this
 * worker as its own process (index.ts).
 *
 * Only the events consumer: no provider sweeps, no embedding (ingest) or
 * batch-jobs worker. The loop waits on the store's queue notify rather
 * than polling, when the host passes one.
 */

import { wakeOnSignal, type LoopWake } from '@renkei/worker-loop';
import { eventsQueue } from './queue';
import { handlerFor } from './handlers';
import { registerConnectorHandlers } from './connector-handlers';
import { createEventLoop } from './loop';

export interface EmbeddedWorker {
  /** Stop claiming; resolves once the event in hand has wound down. */
  stop(): Promise<void>;
}

export function startEmbeddedEventDispatcher(options: { wake?: LoopWake } = {}): EmbeddedWorker {
  registerConnectorHandlers();
  const claim = () => eventsQueue.consumer.claim();
  const loop = createEventLoop({
    ...(options.wake ? wakeOnSignal(options.wake, claim) : { claim }),
    complete: (event, outcome) => eventsQueue.consumer.complete(event, outcome),
    fail: (event, error) => eventsQueue.consumer.fail(event, error),
    handlerFor,
    label: 'worker/loop',
  });
  const running = loop.run();
  return {
    stop: async () => {
      loop.stop();
      await running;
    },
  };
}
