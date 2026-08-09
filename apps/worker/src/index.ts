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
import { sweepWebexWebhooks, WEBHOOK_HEALTH_INTERVAL_MS } from './health/webex-webhooks';
import { logger, attachPersistentLogging } from './logger';
import packageJson from '../package.json';

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
  logger.info('webex handlers registered', { component: 'worker/loop' });
}

/**
 * Scheduler-as-part-of-the-loop: the sweep runs on its own cadence inside
 * the poll loop (first pass at boot), so a repair is never further away
 * than one poll interval past due. A sweep failure is logged inside the
 * sweep itself and never disturbs event processing.
 */
let nextWebhookSweepAt = 0;

async function maybeSweepWebhooks(): Promise<void> {
  if (Date.now() < nextWebhookSweepAt) return;
  nextWebhookSweepAt = Date.now() + WEBHOOK_HEALTH_INTERVAL_MS;
  try {
    await sweepWebexWebhooks();
  } catch (error) {
    logger.error('webhook health sweep error: {error}', {
      component: 'webex/webhook-health',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  await attachPersistentLogging();
  registerConnectorHandlers();
  // Console output carries only explicit attrs, so the build identity rides
  // the boot line — `docker logs` answers "what is running" directly.
  logger.info('started {application} {version}', {
    component: 'worker/loop',
    application: packageJson.name,
    version: packageJson.version,
    commit: process.env.GIT_COMMIT ?? 'dev',
  });
  while (running) {
    await maybeSweepWebhooks();
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
