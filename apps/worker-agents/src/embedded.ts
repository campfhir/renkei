/**
 * The agents worker inside another process: the agent_jobs consumer
 * (./consumer.ts — the run engine, the action executor, drafting and
 * optimization) running on the host's event loop. For the web app on the
 * in-memory data store (apps/web/lib/memory-workers.ts), where the memory
 * store lives in one process and the consumer has to claim from the
 * queue the web app's routes enqueue into; for nothing in a real
 * deployment, which runs this worker as its own process (index.ts).
 *
 * Only the consumer: no schedule, approval, retention or janitor sweep.
 * The loop waits on the store's queue notify rather than polling, when
 * the host passes one.
 */

import type { LoopWake } from '@renkei/worker-loop';
import { createAgentJobsConsumer } from './consumer';

export interface EmbeddedWorker {
  /** Stop claiming; resolves once the message in hand has wound down. */
  stop(): Promise<void>;
}

export function startEmbeddedAgentsWorker(options: {
  /** The host web app's own base URL: tools run through its MCP endpoint. */
  webBaseUrl: string;
  wake?: LoopWake;
}): EmbeddedWorker {
  const consumer = createAgentJobsConsumer({
    webBaseUrl: options.webBaseUrl.replace(/\/+$/, ''),
    wake: options.wake,
  });
  const running = consumer.loop.run();
  return {
    stop: async () => {
      consumer.stop();
      await running;
    },
  };
}
