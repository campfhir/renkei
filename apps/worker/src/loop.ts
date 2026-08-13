/**
 * The event-processing loop, extracted from the entrypoint so both worker
 * processes (Decision #20) — and the synthetic multi-stream test — run the
 * exact same machinery with only the queue wiring differing.
 *
 * The loop is deliberately serial: one claimed event, fully handled, then
 * the next. Isolation between event classes comes from separate queues and
 * processes, and concurrency from running more loop instances (row-locked
 * claims and ordering keys make that safe) — never from in-process fan-out.
 */

import type { ClaimedEvent, Disposition } from './queue';
import type { EventHandler } from './handlers';
import { logger } from './logger';

/** Poll cadence: quick when draining a backlog, relaxed when idle. */
const BUSY_DELAY_MS = 100;
const IDLE_DELAY_MS = 5_000;

export interface EventLoopDeps {
  claim: () => Promise<ClaimedEvent | null>;
  complete: (event: ClaimedEvent) => Promise<void>;
  fail: (event: ClaimedEvent, error: string) => Promise<Disposition>;
  handlerFor: (event: Pick<ClaimedEvent, 'source' | 'type'>) => EventHandler | undefined;
  busyDelayMs?: number;
  idleDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Log component tag — distinguishes the two processes' lines. */
  label?: string;
}

export interface EventLoop {
  /** One claim-and-handle pass; true when an event was claimed. */
  processOne(): Promise<boolean>;
  /** Poll until stop(); resolves once the current event has wound down. */
  run(): Promise<void>;
  stop(): void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEventLoop(deps: EventLoopDeps): EventLoop {
  const busyDelayMs = deps.busyDelayMs ?? BUSY_DELAY_MS;
  const idleDelayMs = deps.idleDelayMs ?? IDLE_DELAY_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const component = deps.label ?? 'worker/loop';
  let running = true;

  async function processOne(): Promise<boolean> {
    const event = await deps.claim();
    if (!event) return false;

    // Claiming was previously silent on success — the only way to tell a
    // message was ever picked up was the absence of a failure log, which
    // looks identical to "never claimed at all". This line disambiguates.
    logger.debug('claimed event {eventId} ({source}/{type}), attempt {attempts}', {
      component,
      eventId: event.id,
      source: event.source,
      type: event.type,
      attempts: event.attempts,
    });

    const handler = deps.handlerFor(event);
    if (!handler) {
      const disposition = await deps.fail(
        event,
        `no handler registered for ${event.source}/${event.type}`
      );
      logger.warn(
        'no handler for {source}/{type} (event {eventId}, attempt {attempts}) → {status}',
        {
          component,
          source: event.source,
          type: event.type,
          eventId: event.id,
          attempts: event.attempts,
          status: disposition.status,
        }
      );
      return true;
    }

    try {
      await handler(event);
      await deps.complete(event);
      logger.debug('completed event {eventId}', { component, eventId: event.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const disposition = await deps.fail(event, message);
      logger.error(
        'event {eventId} ({source}/{type}) failed on attempt {attempts}: {error} → {status}',
        {
          component,
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

  async function run(): Promise<void> {
    while (running) {
      let hadWork = false;
      try {
        hadWork = await processOne();
      } catch (error) {
        // A claim/complete failure here is a database problem, not an event
        // problem; back off and let the loop retry.
        logger.error('loop error: {error}', {
          component,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(hadWork ? busyDelayMs : idleDelayMs);
    }
  }

  return {
    processOne,
    run,
    stop: () => {
      running = false;
    },
  };
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
export function schedulePeriodicSweep(
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
