/**
 * @renkei/worker-loop — the queue-consumption machinery every worker
 * process runs, promoted from apps/worker/src/loop.ts when a third
 * consumer (apps/worker-agents) arrived.
 *
 * The loop is deliberately serial: one claimed message, fully handled,
 * then the next. Isolation between message classes comes from separate
 * queues and processes, and concurrency from running more loop instances
 * (row-locked claims and ordering keys make that safe) — never from
 * in-process fan-out.
 *
 * The logger is injected: each worker app has its own bored-logs instance
 * stamped with its own package identity, and this package must not choose
 * one for them. `LoopLogger` is the structural slice of that logger the
 * loop actually uses.
 */

/** The structural slice of a bored-logs logger the loop needs. */
export interface LoopLogger {
  debug(message: string, attrs?: Record<string, unknown>): void;
  warn(message: string, attrs?: Record<string, unknown>): void;
  error(message: string, attrs?: Record<string, unknown>): void;
}

/** The claimed-message slice the loop reads (matches @renkei/queue rows). */
export interface LoopMessage {
  id: string;
  source: string;
  type: string;
  attempts: number;
}

export type LoopDisposition = { status: 'retry'; delaySeconds: number } | { status: 'dead' };

/**
 * A handler's resolution. Returning nothing means the work was done;
 * 'skipped' means the handler decided there was nothing to do (no grant, a
 * stale notification, a feature switched off) — still an ack, recorded so
 * the admin's event monitor can tell the two apart.
 */
export type HandlerResolution = void | 'skipped';

/**
 * Thrown by a handler that is stopping on purpose partway through a
 * message — the process is shutting down and the work reached a
 * checkpoint it can be resumed from. The loop then hands the message
 * back to the queue untouched (`release`: pending again, no attempt
 * spent) instead of failing it, so the next consumer — this process
 * after its restart, or a replica — picks it up at once rather than
 * after a retry backoff or, worse, a lease expiry.
 */
export class MessageReleased extends Error {
  constructor(reason = 'the consumer is stopping') {
    super(reason);
    this.name = 'MessageReleased';
  }
}

/** Poll cadence: quick when draining a backlog, relaxed when idle. The idle
 * delay bounds per-hop latency for push-driven work — an event crosses up to
 * three queue hops (intake → domain lane → agent job), so 1s keeps the
 * webhook-to-agent-run feel well under the ~30s target while costing only a
 * few indexed single-row claim queries per second across all consumers. */
const BUSY_DELAY_MS = 100;
const IDLE_DELAY_MS = 1_000;

export interface EventLoopDeps<M extends LoopMessage> {
  claim: () => Promise<M | null>;
  complete: (message: M, outcome?: 'processed' | 'skipped') => Promise<void>;
  fail: (message: M, error: string) => Promise<LoopDisposition>;
  /**
   * Hands a message back untouched when its handler threw MessageReleased.
   * Omitted, a released message is failed like any other error — a
   * queue without the operation still makes progress, just more slowly.
   */
  release?: (message: M) => Promise<void>;
  handlerFor: (
    message: Pick<M, 'source' | 'type'>
  ) => ((message: M) => Promise<HandlerResolution>) | undefined;
  logger: LoopLogger;
  busyDelayMs?: number;
  idleDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Log component tag — distinguishes the processes' lines. */
  label?: string;
}

export interface EventLoop {
  /** One claim-and-handle pass; true when a message was claimed. */
  processOne(): Promise<boolean>;
  /** Poll until stop(); resolves once the current message has wound down. */
  run(): Promise<void>;
  stop(): void;
  /**
   * True once stop() was called: what a long handler polls at its own
   * checkpoints to decide to throw MessageReleased rather than carry on
   * into work the process will not live to finish.
   */
  readonly stopping: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEventLoop<M extends LoopMessage>(deps: EventLoopDeps<M>): EventLoop {
  const busyDelayMs = deps.busyDelayMs ?? BUSY_DELAY_MS;
  const idleDelayMs = deps.idleDelayMs ?? IDLE_DELAY_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const component = deps.label ?? 'worker/loop';
  const logger = deps.logger;
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
      const resolution = await handler(event);
      const outcome = resolution === 'skipped' ? 'skipped' : 'processed';
      await deps.complete(event, outcome);
      logger.debug('completed event {eventId} ({outcome})', {
        component,
        eventId: event.id,
        outcome,
      });
    } catch (error) {
      if (error instanceof MessageReleased && deps.release) {
        await deps.release(event);
        logger.warn('event {eventId} ({source}/{type}) released on attempt {attempts}: {reason}', {
          component,
          eventId: event.id,
          source: event.source,
          type: event.type,
          attempts: event.attempts,
          reason: error.message,
        });
        return true;
      }
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
    get stopping() {
      return !running;
    },
  };
}

/**
 * A periodic sweep, on its own independent timer — never `await`ed by the
 * event-processing loop.
 *
 * Sweeps used to run inline at the front of the poll loop; a sweep that
 * got stuck wedged event processing right along with it. Running each on
 * its own timer removes that coupling: the worst a wedged sweep can do
 * now is wedge itself.
 *
 * Self-throttling by construction — `tick` only schedules its own next run
 * after the current one settles, so a slow sweep skips a beat rather than
 * piling up concurrent runs of itself. A sweep failure is logged here and
 * never propagates.
 */
export function schedulePeriodicSweep(
  logger: LoopLogger,
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

  // The organization's log level (admin → Settings → Data & logs) must be
  // debug for the two lines above to actually show; it defaults to info.
  logger.debug(`${label} sweep scheduled every ${intervalMs}ms`, { component });
  void tick(); // first pass at boot, concurrent with event processing starting up
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
