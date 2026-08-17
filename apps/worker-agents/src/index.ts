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
import { agentJobsQueue, webhookEventsQueue } from '@renkei/queue';
import { createEventLoop, schedulePeriodicSweep } from '@renkei/worker-loop';
import { createAgentRunHandler } from './engine';
import { createFinalizeHook } from './finalize';
import { createScheduleSweep } from './schedule-sweep';
import { createRetentionSweep, createStuckRunJanitor } from './maintenance';
import { createMemoryCompactionSweep, MEMORY_COMPACTION_SWEEP_MS } from './memory-compaction';
import { logger, attachPersistentLogging } from './logger';

const SCHEDULE_SWEEP_MS = 60_000;
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
  await attachPersistentLogging();

  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('Database unavailable at boot');

  const db = dbResult.val;
  const handleRun = createAgentRunHandler({
    db,
    webBaseUrl: webBaseUrl(),
    // Chained agents go back onto OUR queue; failure notifications go to
    // the interactive worker's, which owns the connector delivery paths.
    onFinalized: createFinalizeHook(db, queue.producer, webhookEventsQueue().producer),
  });

  // Every sweep is replica-safe: the schedule advance is optimistically
  // locked, retention and the janitor are idempotent.
  const stopSweeps = [
    schedulePeriodicSweep(
      logger,
      'agent schedules',
      'worker-agents/schedule',
      SCHEDULE_SWEEP_MS,
      createScheduleSweep(db, queue.producer)
    ),
    schedulePeriodicSweep(
      logger,
      'agent run retention',
      'worker-agents/retention',
      RETENTION_SWEEP_MS,
      createRetentionSweep(db)
    ),
    schedulePeriodicSweep(
      logger,
      'stuck runs',
      'worker-agents/janitor',
      JANITOR_SWEEP_MS,
      createStuckRunJanitor(db)
    ),
    // Replica-safe by construction (equivalent summaries, idempotent
    // deletes) — see memory-compaction.ts.
    schedulePeriodicSweep(
      logger,
      'memory compaction',
      'worker-agents/memory-compaction',
      MEMORY_COMPACTION_SWEEP_MS,
      createMemoryCompactionSweep(db)
    ),
  ];

  const loop = createEventLoop({
    claim: () => queue.consumer.claim(),
    complete: (event) => queue.consumer.complete(event),
    fail: (event, error) => queue.consumer.fail(event, error),
    // Runs enqueue under a per-agent fairness lane (`agents:{agentId}`);
    // the bare `agents` form still matches so rows enqueued before lanes
    // existed drain normally.
    handlerFor: (event) =>
      (event.source === 'agents' || event.source.startsWith('agents:')) && event.type === 'run'
        ? handleRun
        : undefined,
    logger,
    label: 'worker-agents/loop',
  });

  const shutdown = (signal: string): void => {
    logger.info('{signal} received, finishing current run step', {
      component: 'worker-agents/loop',
      signal,
    });
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
