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

/** Poll cadence: quick when draining a backlog, relaxed when idle. */
const BUSY_DELAY_MS = 100;
const IDLE_DELAY_MS = 5_000;

let running = true;

async function processOne(): Promise<boolean> {
  const event = await claimNextEvent();
  if (!event) return false;

  const handler = handlerFor(event);
  if (!handler) {
    const disposition = await failEvent(event, `no handler registered for ${event.source}/${event.type}`);
    console.warn(
      `[worker] no handler for ${event.source}/${event.type} (event ${event.id}, attempt ${event.attempts}) → ${disposition.status}`
    );
    return true;
  }

  try {
    await handler(event);
    await completeEvent(event.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const disposition = await failEvent(event, message);
    console.error(
      `[worker] event ${event.id} (${event.source}/${event.type}) failed on attempt ${event.attempts}: ${message} → ${disposition.status}`
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
  console.log('[worker] webex handlers registered');
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
    console.error(
      '[worker] webhook health sweep error:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function main(): Promise<void> {
  registerConnectorHandlers();
  console.log('[worker] started');
  while (running) {
    await maybeSweepWebhooks();
    let hadWork = false;
    try {
      hadWork = await processOne();
    } catch (error) {
      // A claim/complete failure here is a database problem, not an event
      // problem; back off and let the loop retry.
      console.error('[worker] loop error:', error instanceof Error ? error.message : String(error));
    }
    await sleep(hadWork ? BUSY_DELAY_MS : IDLE_DELAY_MS);
  }
  await closeDatabase();
  console.log('[worker] stopped');
}

function shutdown(signal: string): void {
  console.log(`[worker] ${signal} received, finishing current event`);
  running = false;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
