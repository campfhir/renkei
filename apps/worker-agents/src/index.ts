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

import { checkDataStore, closeDataStore } from '@renkei/db';
import { developmentDelegateKeyRefusal } from '@renkei/delegate-client';
import { agentJobsQueue } from '@renkei/queue';
import { schedulePeriodicSweep } from '@renkei/worker-loop';
import { createAgentJobsConsumer } from './consumer';
import { createDraftSweep, DRAFT_SWEEP_INTERVAL_MS } from './draft-sweep';
import {
  createChatRetentionSweep,
  createChatTurnJanitor,
  CHAT_JANITOR_INTERVAL_MS,
  CHAT_RETENTION_INTERVAL_MS,
} from './chat-sweep';
import { createOptimizationSweep, OPTIMIZATION_SWEEP_INTERVAL_MS } from './optimization-sweep';
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

  if (!checkDataStore().ok) throw new Error('Database unavailable at boot');
  const consumer = createAgentJobsConsumer({ webBaseUrl: webBaseUrl() });

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

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, handing the current run back at its next checkpoint', {
      component: 'worker-agents/loop',
      signal,
    });
    consumer.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('started {application} {version} (agent_jobs queue)', {
    component: 'worker-agents/loop',
  });
  await consumer.loop.run();
  for (const stop of stopSweeps) stop();
  logger.info('stopped', { component: 'worker-agents/loop' });
  await logger.flush();
  await closeDataStore();
}

void main().catch((error) => {
  console.error('[worker-agents] fatal:', error);
  process.exit(1);
});
