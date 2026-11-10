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

/** Lease renewal cadence: several renewals inside agent_jobs' 30-minute lease. */
const LEASE_RENEW_MS = 5 * 60_000;
/**
 * The longest one claim is renewed for, and the longest this loop waits on
 * one handler — the stuck-run janitor's horizon. Past it the loop claims
 * the next job; the hung one's lease lapses and the queue reclaims it.
 */
const MAX_HOLD_MS = 2 * 60 * 60_000;

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
    // A run segment can spend the org's whole active-time budget (30
    // minutes by default) inside one claim — as long as the 30-minute
    // lease. Unrenewed, a slow run was reclaimed by a second worker and
    // executed twice at once, and the second's failure unlocked the
    // agent's ordering key under the first. Renewed while it runs, up to
    // the stuck-run janitor's two hours, after which a hung handler loses
    // its claim like a dead worker's — and this loop stops waiting on it,
    // so one run that never returns cannot stop this replica claiming for
    // as long as it lives.
    extend: (event) => queue.consumer.extend(event),
    extendEveryMs: LEASE_RENEW_MS,
    maxHoldMs: MAX_HOLD_MS,
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
