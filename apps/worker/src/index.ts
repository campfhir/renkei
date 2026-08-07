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
import { handlerFor } from './handlers';

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

async function main(): Promise<void> {
  console.log('[worker] started');
  while (running) {
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
