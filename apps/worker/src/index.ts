/**
 * The Renkei worker — the long-running half of the Decision #17 topology.
 *
 * Everything that must keep running lives here, never in a web request
 * handler: the events-queue consumer now; schedulers-as-producers and
 * provider subscription renewal as they arrive. The web app's only queue
 * role is INSERTing events.
 */

import { closeDatabase } from '@renkei/db';
import { claimNextEvent, completeEvent, failEvent } from './queue';
import { handlerFor, registerHandler } from './handlers';
import { createWebexMessageHandler } from './handlers/webex-message';
import { createWebexAttachmentActionHandler } from './handlers/webex-attachment-action';
import {
  createMicrosoftGrantConnectedHandler,
  createMicrosoftChangeNotificationHandler,
  createMicrosoftLifecycleHandler,
  createMicrosoftMessageOverrideHandler,
} from './handlers/microsoft-events';
import { createZoomTranscriptHandler, createZoomSummaryHandler } from './handlers/zoom-events';
import { sweepWebexWebhooks, WEBHOOK_HEALTH_INTERVAL_MS } from './health/webex-webhooks';
import { sweepAtlassianWatches, ATLASSIAN_WATCH_INTERVAL_MS } from './health/atlassian-watches';
import {
  sweepMicrosoftSubscriptions,
  MICROSOFT_SUBSCRIPTION_INTERVAL_MS,
} from './health/microsoft-subscriptions';
import { logger, attachPersistentLogging } from './logger';

/** Poll cadence: quick when draining a backlog, relaxed when idle. */
const BUSY_DELAY_MS = 100;
const IDLE_DELAY_MS = 5_000;

let running = true;

async function processOne(): Promise<boolean> {
  const event = await claimNextEvent();
  if (!event) return false;

  const handler = handlerFor(event);
  if (!handler) {
    const disposition = await failEvent(
      event,
      `no handler registered for ${event.source}/${event.type}`
    );
    logger.warn('no handler for {source}/{type} (event {eventId}, attempt {attempts}) → {status}', {
      component: 'worker/loop',
      source: event.source,
      type: event.type,
      eventId: event.id,
      attempts: event.attempts,
      status: disposition.status,
    });
    return true;
  }

  try {
    await handler(event);
    await completeEvent(event.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const disposition = await failEvent(event, message);
    logger.error(
      'event {eventId} ({source}/{type}) failed on attempt {attempts}: {error} → {status}',
      {
        component: 'worker/loop',
        eventId: event.id,
        source: event.source,
        type: event.type,
        attempts: event.attempts,
        error: message,
        status: disposition.status,
      }
    );
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handlers register unconditionally; whether a connector is actually
 * configured is per-tenant database state, resolved when its events are
 * processed. A tenant without configuration fails its events visibly (into
 * the retry/dead-letter path) rather than having them silently swallowed.
 */
function registerConnectorHandlers(): void {
  registerHandler('webex', 'messages.created', createWebexMessageHandler());
  registerHandler('webex', 'attachmentActions.created', createWebexAttachmentActionHandler());
  registerHandler('microsoft', 'grant.connected', createMicrosoftGrantConnectedHandler());
  registerHandler('microsoft', 'change-notification', createMicrosoftChangeNotificationHandler());
  registerHandler('microsoft', 'lifecycle', createMicrosoftLifecycleHandler());
  registerHandler('microsoft', 'message-override', createMicrosoftMessageOverrideHandler());
  registerHandler('zoom', 'recording.transcript_completed', createZoomTranscriptHandler());
  registerHandler('zoom', 'meeting.summary_completed', createZoomSummaryHandler());
  logger.info('webex, microsoft and zoom handlers registered', { component: 'worker/loop' });
}

/**
 * A periodic sweep, on its own independent timer — never `await`ed by the
 * event-processing loop.
 *
 * Sweeps used to run inline at the front of the poll loop: `await
 * maybeSweepWebhooks()` before every `processOne()`. That meant a sweep
 * that got stuck — an unreachable third-party API, back when the connector
 * clients had no fetch timeout — wedged event processing right along with
 * it, indefinitely, with nothing logged to explain why. The connector
 * clients are now bounded (15–60s per call), which caps how long a stuck
 * sweep can run, but a slow-not-hung sweep could still stack up and delay
 * every event behind it. Running each sweep on its own timer removes that
 * coupling entirely: the worst a wedged sweep can do now is wedge itself.
 *
 * Self-throttling by construction — `tick` only schedules its own next run
 * after the current one settles, so a slow sweep skips a beat rather than
 * piling up concurrent runs of itself. A sweep failure is logged here and
 * never propagates.
 */
function schedulePeriodicSweep(
  label: string,
  component: string,
  intervalMs: number,
  sweep: () => Promise<void>
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    logger.debug(`${label} sweep starting`, { component });
    try {
      await sweep();
      logger.debug(`${label} sweep finished`, { component });
    } catch (error) {
      logger.error(`${label} sweep error: {error}`, {
        component,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  // CONSOLE_LOG_LEVEL (and LOG_DB_LEVEL for the persisted copy) must be set
  // to 'debug' for the two lines above to actually show — both default to
  // 'info' in logger.ts, same as the web app's.
  logger.debug(`${label} sweep scheduled every ${intervalMs}ms`, { component });
  void tick(); // first pass at boot, concurrent with event processing starting up
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

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
      'atlassian watch',
      'atlassian/watch-sweep',
      ATLASSIAN_WATCH_INTERVAL_MS,
      sweepAtlassianWatches
    ),
  ];

  while (running) {
    let hadWork = false;
    try {
      hadWork = await processOne();
    } catch (error) {
      // A claim/complete failure here is a database problem, not an event
      // problem; back off and let the loop retry.
      logger.error('loop error: {error}', {
        component: 'worker/loop',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(hadWork ? BUSY_DELAY_MS : IDLE_DELAY_MS);
  }
  stopSweeps.forEach((stop) => stop());
  logger.info('stopped', { component: 'worker/loop' });
  // Drain the adapters — the HttpAdapter's queue especially — while the
  // database and event loop are still alive to receive them.
  await logger.flush();
  await closeDatabase();
}

function shutdown(signal: string): void {
  logger.info('{signal} received, finishing current event', { component: 'worker/loop', signal });
  running = false;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
