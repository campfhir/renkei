/**
 * The Renkei interactive worker — the long-running half of the Decision #17
 * topology, consuming the webhook `events` queue.
 *
 * Everything that must keep running lives here, never in a web request
 * handler: the events-queue consumer, schedulers-as-producers and provider
 * subscription renewal. The web app's only queue role is producing events.
 *
 * Embedding/ingestion work does NOT live here (Decision #20): handlers
 * enqueue `knowledge/*` jobs onto the embedding queue (`embedding_jobs`),
 * consumed by the separate embedding worker process
 * (embeddings-worker.ts), so a slow org-configured embeddings endpoint can
 * never delay a reply. Both queues claim with row locks, so more instances
 * of either process can be added without coordination.
 */

import { checkDataStore, closeDataStore } from '@renkei/db';
import { developmentDelegateKeyRefusal } from '@renkei/delegate-client';
import { eventsQueue } from './queue';
import { handlerFor } from './handlers';
import { registerConnectorHandlers } from './connector-handlers';
import { createEventLoop, schedulePeriodicSweep } from './loop';
import { createMailJobsSweep, MAIL_JOBS_SWEEP_INTERVAL_MS } from './health/mail-jobs';
import { sweepLogRetention, LOG_RETENTION_SWEEP_INTERVAL_MS } from './health/log-retention';
import { sweepExpiredGrants, EXPIRED_GRANTS_SWEEP_INTERVAL_MS } from './health/expired-grants';
import { createUploadSlotsSweep, UPLOAD_SLOTS_SWEEP_INTERVAL_MS } from './health/upload-slots';
import { createAgentFiringsSweep, AGENT_FIRINGS_SWEEP_INTERVAL_MS } from './health/agent-firings';
import { createWebexSentSweep, WEBEX_SENT_SWEEP_INTERVAL_MS } from './health/webex-sent';
import { withSweepLock } from './health/sweep-lock';
import { sweepWebexWebhooks, WEBHOOK_HEALTH_INTERVAL_MS } from './health/webex-webhooks';
import { sweepContentWatches, CONTENT_WATCH_INTERVAL_MS } from './health/content-watches';
import { sweepWebexWindows, WEBEX_WINDOW_SWEEP_INTERVAL_MS } from './health/webex-windows';
import {
  sweepMicrosoftSubscriptions,
  MICROSOFT_SUBSCRIPTION_INTERVAL_MS,
} from './health/microsoft-subscriptions';
import { logger, attachPersistentLogging } from './logger';
import { watchLogLevel } from '@renkei/settings';

const loop = createEventLoop({
  claim: () => eventsQueue.consumer.claim(),
  complete: (event, outcome) => eventsQueue.consumer.complete(event, outcome),
  fail: (event, error) => eventsQueue.consumer.fail(event, error),
  handlerFor,
  label: 'worker/loop',
});

async function main(): Promise<void> {
  // The delegate key is this process's identity to the key service; the
  // compose file's development default is refused in production
  // (docs/delegate-key-design.md, "Callers").
  const delegateKeyRefusal = developmentDelegateKeyRefusal();
  if (delegateKeyRefusal) {
    console.error(`FATAL [worker]: ${delegateKeyRefusal}`);
    process.exit(1);
  }
  await attachPersistentLogging();
  // Every adapter starts at info, which holds only for the few seconds
  // before the database is reachable; once it is, the org `logLevel` dial
  // (packages/settings) governs, polled and reapplied here so a saved
  // change takes effect without restarting this process.
  watchLogLevel(logger);
  registerConnectorHandlers();
  // application/version/commit ride on every line as global attrs (see
  // logger.ts) — this boot line just makes the plain-English announcement.
  logger.info('started {application} {version}', { component: 'worker/loop' });
  // Independent of the poll loop below — see schedulePeriodicSweep's doc
  // comment for why. Stopped only once event processing has wound down, so
  // "stopped" in the log means everything actually stopped.
  const stopSweeps = [
    // The provider-facing sweeps are list-then-create against external
    // systems, so with multiple worker replicas they run under an advisory
    // lock — one runner per pass, or duplicate webhook registrations
    // double-deliver every event (see sweep-lock.ts).
    schedulePeriodicSweep(
      'webhook health',
      'webex/webhook-health',
      WEBHOOK_HEALTH_INTERVAL_MS,
      withSweepLock('webex-webhooks', sweepWebexWebhooks)
    ),
    schedulePeriodicSweep(
      'microsoft subscription',
      'microsoft/subscription-health',
      MICROSOFT_SUBSCRIPTION_INTERVAL_MS,
      withSweepLock('microsoft-subscriptions', sweepMicrosoftSubscriptions)
    ),
    schedulePeriodicSweep(
      'content watch',
      'content/watch-sweep',
      CONTENT_WATCH_INTERVAL_MS,
      withSweepLock('content-watches', sweepContentWatches)
    ),
    // One runner per pass: two replicas draining the same dirty windows
    // would enqueue every rebuild twice.
    schedulePeriodicSweep(
      'webex windows',
      'webex/window-sweep',
      WEBEX_WINDOW_SWEEP_INTERVAL_MS,
      withSweepLock('webex-windows', sweepWebexWindows)
    ),
    // Under the advisory lock like the provider sweeps: purge jobs are
    // resumable, but two replicas planning the same purge is still waste.
    schedulePeriodicSweep(
      'log retention',
      'logs/retention-sweep',
      LOG_RETENTION_SWEEP_INTERVAL_MS,
      withSweepLock('log-retention', sweepLogRetention)
    ),
    // Deletes are idempotent, but one runner per pass keeps the log line
    // per deleted grant single, so the advisory lock rides along.
    schedulePeriodicSweep(
      'expired grants',
      'grants/expiry-sweep',
      EXPIRED_GRANTS_SWEEP_INTERVAL_MS,
      withSweepLock('expired-grants', sweepExpiredGrants)
    ),
    ...(() => {
      // Row hygiene: fail stalled mail runs, expire/prune upload slots.
      return checkDataStore().ok
        ? [
            schedulePeriodicSweep(
              'mail bulk jobs',
              'mailjobs/sweep',
              MAIL_JOBS_SWEEP_INTERVAL_MS,
              createMailJobsSweep()
            ),
            schedulePeriodicSweep(
              'upload slots',
              'uploadslots/sweep',
              UPLOAD_SLOTS_SWEEP_INTERVAL_MS,
              createUploadSlotsSweep()
            ),
            schedulePeriodicSweep(
              'agent trigger firings',
              'agentfirings/sweep',
              AGENT_FIRINGS_SWEEP_INTERVAL_MS,
              createAgentFiringsSweep()
            ),
            schedulePeriodicSweep(
              'sent WebEx messages',
              'webexsent/sweep',
              WEBEX_SENT_SWEEP_INTERVAL_MS,
              createWebexSentSweep()
            ),
          ]
        : [];
    })(),
  ];

  await loop.run();
  stopSweeps.forEach((stop) => stop());
  logger.info('stopped', { component: 'worker/loop' });
  // Drain the adapters — the HttpAdapter's queue especially — while the
  // database and event loop are still alive to receive them.
  await logger.flush();
  await closeDataStore();
}

function shutdown(signal: string): void {
  logger.info('{signal} received, finishing current event', { component: 'worker/loop', signal });
  loop.stop();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
