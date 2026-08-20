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

import { closeDatabase, getDatabase } from '@renkei/db';
import { eventsQueue } from './queue';
import { handlerFor, registerHandler } from './handlers';
import { createEventLoop, schedulePeriodicSweep } from './loop';
import { createWebexUserMessageHandler } from './handlers/webex-user-message';
import {
  createMicrosoftGrantConnectedHandler,
  createMicrosoftChangeNotificationHandler,
  createMicrosoftLifecycleHandler,
  createMicrosoftMessageOverrideHandler,
} from './handlers/microsoft-events';
import { createZoomTranscriptHandler, createZoomSummaryHandler } from './handlers/zoom-events';
import { createDomainDispatchHandler } from './handlers/domain-dispatch';
import { createAgentRunFailedHandler } from './handlers/agent-run-failed';
import { createMailBulkJobHandler } from './handlers/mail-bulk-jobs';
import { createMailJobsSweep, MAIL_JOBS_SWEEP_INTERVAL_MS } from './health/mail-jobs';
import { createUploadSlotsSweep, UPLOAD_SLOTS_SWEEP_INTERVAL_MS } from './health/upload-slots';
import { sweepWebexWebhooks, WEBHOOK_HEALTH_INTERVAL_MS } from './health/webex-webhooks';
import { sweepContentWatches, CONTENT_WATCH_INTERVAL_MS } from './health/content-watches';
import {
  sweepMicrosoftSubscriptions,
  MICROSOFT_SUBSCRIPTION_INTERVAL_MS,
} from './health/microsoft-subscriptions';
import { logger, attachPersistentLogging } from './logger';

/**
 * Handlers register unconditionally; whether a connector is actually
 * configured is per-tenant database state, resolved when its events are
 * processed. A tenant without configuration fails its events visibly (into
 * the retry/dead-letter path) rather than having them silently swallowed.
 */
function registerConnectorHandlers(): void {
  registerHandler('webex', 'user-message.created', createWebexUserMessageHandler());
  registerHandler('microsoft', 'grant.connected', createMicrosoftGrantConnectedHandler());
  registerHandler('microsoft', 'change-notification', createMicrosoftChangeNotificationHandler());
  registerHandler('microsoft', 'lifecycle', createMicrosoftLifecycleHandler());
  registerHandler('microsoft', 'message-override', createMicrosoftMessageOverrideHandler());
  registerHandler('zoom', 'recording.transcript_completed', createZoomTranscriptHandler());
  registerHandler('zoom', 'meeting.summary_completed', createZoomSummaryHandler());
  // Async Outlook bulk mail actions — submitted by the MCP tool as a bare
  // {jobId} pointer; the mail_bulk_jobs row is the source of truth.
  registerHandler('mailjobs', 'bulk-action', createMailBulkJobHandler());
  // Emitted by worker-agents when a run fails; delivery of the owner's
  // notification belongs here, where the connector paths live. (run.reply
  // is gone: agents that answer in a room do it as a STEP now.)
  registerHandler('agents', 'run.failed', createAgentRunFailedHandler());
  // Domain events published by the provider handlers above arrive on
  // `domain:{provider}` lanes; the colon-lane fallback in handlerFor
  // resolves them to the one dispatch handler, registered per type.
  const dispatch = createDomainDispatchHandler();
  registerHandler('domain', 'message.received', dispatch);
  registerHandler('domain', 'mail.received', dispatch);
  registerHandler('domain', 'recording.transcript_completed', dispatch);
  registerHandler('domain', 'meeting.summary_completed', dispatch);
  logger.info('webex, microsoft, zoom and dispatch handlers registered', {
    component: 'worker/loop',
  });
}

const loop = createEventLoop({
  claim: () => eventsQueue.consumer.claim(),
  complete: (event) => eventsQueue.consumer.complete(event),
  fail: (event, error) => eventsQueue.consumer.fail(event, error),
  handlerFor,
  label: 'worker/loop',
});

async function main(): Promise<void> {
  await attachPersistentLogging();
  registerConnectorHandlers();
  // application/version/commit ride on every line as global attrs (see
  // logger.ts) — this boot line just makes the plain-English announcement.
  logger.info('started {application} {version}', { component: 'worker/loop' });
  // Independent of the poll loop below — see schedulePeriodicSweep's doc
  // comment for why. Stopped only once event processing has wound down, so
  // "stopped" in the log means everything actually stopped.
  const stopSweeps = [
    schedulePeriodicSweep(
      'webhook health',
      'webex/webhook-health',
      WEBHOOK_HEALTH_INTERVAL_MS,
      sweepWebexWebhooks
    ),
    schedulePeriodicSweep(
      'microsoft subscription',
      'microsoft/subscription-health',
      MICROSOFT_SUBSCRIPTION_INTERVAL_MS,
      sweepMicrosoftSubscriptions
    ),
    schedulePeriodicSweep(
      'content watch',
      'content/watch-sweep',
      CONTENT_WATCH_INTERVAL_MS,
      sweepContentWatches
    ),
    ...(() => {
      // Row hygiene: fail stalled mail runs, expire/prune upload slots.
      const dbResult = getDatabase();
      return dbResult.ok
        ? [
            schedulePeriodicSweep(
              'mail bulk jobs',
              'mailjobs/sweep',
              MAIL_JOBS_SWEEP_INTERVAL_MS,
              createMailJobsSweep(dbResult.val)
            ),
            schedulePeriodicSweep(
              'upload slots',
              'uploadslots/sweep',
              UPLOAD_SLOTS_SWEEP_INTERVAL_MS,
              createUploadSlotsSweep(dbResult.val)
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
  await closeDatabase();
}

function shutdown(signal: string): void {
  logger.info('{signal} received, finishing current event', { component: 'worker/loop', signal });
  loop.stop();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
