/**
 * The agent_jobs consumer: the run engine, the action executor, drafting
 * and optimization, behind one claim loop. index.ts runs it as this
 * process's whole job, beside the sweeps; embedded.ts runs it inside the
 * web server on the in-memory data store.
 */

import { agentJobsQueue, webhookEventsQueue } from '@renkei/queue';
import { createEventLoop, wakeOnSignal, type EventLoop, type LoopWake } from '@renkei/worker-loop';
import { createAgentRunHandler } from './engine';
import { createActionsHandler } from './actions';
import { createDraftHandler } from './draft';
import { createOptimizeHandler } from './optimize';
import { createFinalizeHook } from './finalize';
import { logger } from './logger';

export interface AgentJobsConsumer {
  loop: EventLoop;
  /** Hand the current run back at its next checkpoint, and stop claiming. */
  stop(): void;
}

export function createAgentJobsConsumer(options: {
  /** Where the web app answers (its MCP endpoint is how tools run). */
  webBaseUrl: string;
  /**
   * What an idle loop waits on instead of its poll interval, when it
   * shares a process with its producers (the memory store's queue notify).
   */
  wake?: LoopWake;
}): AgentJobsConsumer {
  const queue = agentJobsQueue();
  const { webBaseUrl } = options;
  const handleDraft = createDraftHandler({ webBaseUrl });
  const handleOptimize = createOptimizeHandler({ webBaseUrl });
  // Set by stop() and read by the engine at every checkpoint: a run in
  // flight is handed back to the queue at the next one (step, model call,
  // tool call) rather than run to its end — or killed mid-call by the
  // container's stop timeout, which used to leave its job `processing`
  // until the 30-minute lease expired.
  let stopRequested = false;
  const handleRun = createAgentRunHandler({
    webBaseUrl,
    // Accepted batches go onto our own queue, for the action executor.
    actionsProducer: queue.producer,
    // Chained agents go back onto OUR queue; failure notifications go to
    // the interactive worker's, which owns the connector delivery paths.
    onFinalized: createFinalizeHook(queue.producer, webhookEventsQueue().producer),
    stopRequested: () => stopRequested,
  });
  // The only path an agent's changes are made by: accepted batches, under
  // a token of their own, the run handed back when they are done.
  const handleActions = createActionsHandler({ webBaseUrl, runProducer: queue.producer });

  const claim = () => queue.consumer.claim();
  const loop = createEventLoop({
    ...(options.wake ? wakeOnSignal(options.wake, claim) : { claim }),
    complete: (event, outcome) => queue.consumer.complete(event, outcome),
    fail: (event, error) => queue.consumer.fail(event, error),
    // A run the engine hands back on shutdown goes straight back to
    // pending — no attempt spent, no backoff, no lease to wait out.
    release: (event) => queue.consumer.release(event),
    // Runs enqueue under a per-agent fairness lane (`agents:{agentId}`);
    // the bare `agents` form still matches so rows enqueued before lanes
    // existed drain normally.
    handlerFor: (event) => {
      const ours = event.source === 'agents' || event.source.startsWith('agents:');
      if (!ours) return undefined;
      if (event.type === 'run') return handleRun;
      // An accepted action batch — executed apart from the run that staged it.
      if (event.type === 'actions') return handleActions;
      // Drafting from prose: durable so the browser tab need not survive it.
      if (event.type === 'draft') return handleDraft;
      // Failure analysis + revision brief: durable for the same reason.
      if (event.type === 'optimize') return handleOptimize;
      return undefined;
    },
    logger,
    label: 'worker-agents/loop',
  });

  return {
    loop,
    stop: () => {
      stopRequested = true;
      loop.stop();
    },
  };
}
