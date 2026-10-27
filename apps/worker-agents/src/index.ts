/**
 * The Renkei agents worker — the third worker process (RENKEI.md Decision
 * #20's pattern, third application), consuming the `agent_jobs` queue.
 *
 * Every agent run — an LLM loop with tool calls against the web app's own
 * MCP endpoint — executes here, so a slow model can never sit in front of
 * a webhook reply or an embedding job. Scale by adding containers: claims
 * are row-locked, ordering key `agent:{agentId}` keeps one agent's runs
 * serial across any number of instances, the schedule sweep advances rows
 * under an optimistic lock, and the retention/janitor sweeps are
 * idempotent — there is no in-process state a replica could disagree on.
 *
 * Env: DATABASE_URL, TOKEN_ENCRYPTION_KEY (shared roots), plus
 * RENKEI_WEB_INTERNAL_URL — the base URL this process reaches the web app
 * on (its MCP endpoint is how tools are executed, as the run owner).
 */

import { getDatabase, closeDatabase } from '@renkei/db';
import { developmentDelegateKeyRefusal } from '@renkei/delegate-client';
import { agentJobsQueue, webhookEventsQueue } from '@renkei/queue';
import { createEventLoop, schedulePeriodicSweep } from '@renkei/worker-loop';
import { createAgentRunHandler } from './engine';
import { createActionsHandler } from './actions';
import { createDraftHandler } from './draft';
import { createDraftSweep, DRAFT_SWEEP_INTERVAL_MS } from './draft-sweep';
import {
  createChatRetentionSweep,
  createChatTurnJanitor,
  CHAT_JANITOR_INTERVAL_MS,
  CHAT_RETENTION_INTERVAL_MS,
} from './chat-sweep';
import { createOptimizeHandler } from './optimize';
import { createOptimizationSweep, OPTIMIZATION_SWEEP_INTERVAL_MS } from './optimization-sweep';
import { createFinalizeHook } from './finalize';
import { createScheduleSweep } from './schedule-sweep';
import { createApprovalSweep, APPROVAL_SWEEP_MS } from './approval-sweep';
import {
  createUsageRetentionSweep,
  createNotificationRetentionSweep,
  createRetentionSweep,
  createStuckRunJanitor,
  createChatPresenceSweep,
} from './maintenance';
import { createMemoryCompactionSweep, MEMORY_COMPACTION_SWEEP_MS } from './memory-compaction';
import { logger, attachPersistentLogging } from './logger';
import { watchLogLevel } from '@renkei/settings';

// 30s keeps a scheduled agent's mean lateness ~15s — the "runs when I said
// it would" feel; the sweep is one indexed select + optimistic updates, so
// halving the interval is cheap.
const SCHEDULE_SWEEP_MS = 30_000;
const RETENTION_SWEEP_MS = 60 * 60_000;
const JANITOR_SWEEP_MS = 10 * 60_000;

const queue = agentJobsQueue();

function webBaseUrl(): string {
  const raw = process.env.RENKEI_WEB_INTERNAL_URL?.trim();
  if (!raw) {
    // Refusing to boot beats consuming runs that can only fail: without the
    // web URL there is no tool execution at all.
    throw new Error('RENKEI_WEB_INTERNAL_URL is required (e.g. http://web:3000)');
  }
  return raw.replace(/\/+$/, '');
}

async function main(): Promise<void> {
  // The delegate key is this process's identity to the key service; the
  // compose file's development default is refused in production
  // (docs/delegate-key-design.md, "Callers").
  const delegateKeyRefusal = developmentDelegateKeyRefusal();
  if (delegateKeyRefusal) {
    console.error(`FATAL [worker-agents]: ${delegateKeyRefusal}`);
    process.exit(1);
  }
  await attachPersistentLogging();
  // Every adapter starts at info, which holds only for the few seconds
  // before the database is reachable; once it is, the org `logLevel` dial
  // (packages/settings) governs, polled and reapplied here so a saved
  // change takes effect without restarting this process.
  watchLogLevel(logger);

  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('Database unavailable at boot');

  const db = dbResult.val;
  const handleDraft = createDraftHandler({ webBaseUrl: webBaseUrl() });
  const handleOptimize = createOptimizeHandler({ webBaseUrl: webBaseUrl() });
  // Set by the signal handler below and read by the engine at every
  // checkpoint: a run in flight is handed back to the queue at the next
  // one (step, model call, tool call) rather than run to its end — or
  // killed mid-call by the container's stop timeout, which used to leave
  // its job `processing` until the 30-minute lease expired.
  let stopRequested = false;
  const handleRun = createAgentRunHandler({
    db,
    webBaseUrl: webBaseUrl(),
    // Accepted batches go onto our own queue, for the action executor.
    actionsProducer: queue.producer,
    // Chained agents go back onto OUR queue; failure notifications go to
    // the interactive worker's, which owns the connector delivery paths.
    onFinalized: createFinalizeHook(db, queue.producer, webhookEventsQueue().producer),
    stopRequested: () => stopRequested,
  });
  // The only path an agent's changes are made by: accepted batches, under
  // a token of their own, the run handed back when they are done.
  const handleActions = createActionsHandler({
    db,
    webBaseUrl: webBaseUrl(),
    runProducer: queue.producer,
  });

  // Every sweep is replica-safe: the schedule advance is optimistically
  // locked, retention and the janitor are idempotent.
  const stopSweeps = [
    schedulePeriodicSweep(
      logger,
      'agent schedules',
      'worker-agents/schedule',
      SCHEDULE_SWEEP_MS,
      createScheduleSweep(queue.producer)
    ),
    // Approval timeouts + heals: card claims are optimistically locked and
    // duplicate resume enqueues replay harmlessly.
    schedulePeriodicSweep(
      logger,
      'approval waits',
      'worker-agents/approval-sweep',
      APPROVAL_SWEEP_MS,
      createApprovalSweep(queue.producer)
    ),
    schedulePeriodicSweep(
      logger,
      'agent run retention',
      'worker-agents/retention',
      RETENTION_SWEEP_MS,
      createRetentionSweep()
    ),
    // Chat turns whose runner died, and the org's chat retention (bytes
    // before rows). Both idempotent.
    schedulePeriodicSweep(
      logger,
      'chat turn janitor',
      'worker-agents/chat-janitor',
      CHAT_JANITOR_INTERVAL_MS,
      createChatTurnJanitor()
    ),
    schedulePeriodicSweep(
      logger,
      'chat retention',
      'worker-agents/chat-retention',
      CHAT_RETENTION_INTERVAL_MS,
      createChatRetentionSweep()
    ),
    schedulePeriodicSweep(
      logger,
      'agent notification retention',
      'worker-agents/notification-retention',
      RETENTION_SWEEP_MS,
      createNotificationRetentionSweep()
    ),
    // The run log and token ledger outlive their runs by design (a year);
    // this is the bound on that. Idempotent like the run sweep.
    schedulePeriodicSweep(
      logger,
      'agent usage retention',
      'worker-agents/usage-retention',
      RETENTION_SWEEP_MS,
      createUsageRetentionSweep()
    ),
    schedulePeriodicSweep(
      logger,
      'stuck runs',
      'worker-agents/janitor',
      JANITOR_SWEEP_MS,
      createStuckRunJanitor()
    ),
    // Hygiene on the turn stream's own heartbeat table — fixed age, no
    // per-tenant policy to read. Idempotent bounded delete like the sweeps
    // above.
    schedulePeriodicSweep(
      logger,
      'chat presence',
      'worker-agents/chat-presence-sweep',
      JANITOR_SWEEP_MS,
      createChatPresenceSweep()
    ),
    // Rescues drafts stranded by a process that died mid-flight, then
    // prunes old ones. Both halves are idempotent.
    schedulePeriodicSweep(
      logger,
      'agent drafts',
      'worker-agents/draft-sweep',
      DRAFT_SWEEP_INTERVAL_MS,
      createDraftSweep()
    ),
    // The optimization twin of the draft sweep — same two halves.
    schedulePeriodicSweep(
      logger,
      'agent optimizations',
      'worker-agents/optimization-sweep',
      OPTIMIZATION_SWEEP_INTERVAL_MS,
      createOptimizationSweep()
    ),
    // Replica-safe by construction (equivalent summaries, idempotent
    // deletes) — see memory-compaction.ts.
    schedulePeriodicSweep(
      logger,
      'memory compaction',
      'worker-agents/memory-compaction',
      MEMORY_COMPACTION_SWEEP_MS,
      createMemoryCompactionSweep()
    ),
  ];

  const loop = createEventLoop({
    claim: () => queue.consumer.claim(),
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

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, handing the current run back at its next checkpoint', {
      component: 'worker-agents/loop',
      signal,
    });
    stopRequested = true;
    loop.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('started {application} {version} (agent_jobs queue)', {
    component: 'worker-agents/loop',
  });
  await loop.run();
  for (const stop of stopSweeps) stop();
  logger.info('stopped', { component: 'worker-agents/loop' });
  await logger.flush();
  await closeDatabase();
}

void main().catch((error) => {
  console.error('[worker-agents] fatal:', error);
  process.exit(1);
});
