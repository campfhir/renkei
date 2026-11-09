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
  /**
   * Renews the lease on the message being handled; false when it is
   * already lost. Called every `extendEveryMs` while a handler runs, so a
   * handler that is slow but alive keeps its claim instead of having
   * another consumer reclaim the message and run it a second time beside
   * it. Omitted (or without `extendEveryMs`), the lease is never renewed.
   */
  extend?: (message: M) => Promise<boolean>;
  /** How often to renew; well inside the queue's lease. */
  extendEveryMs?: number;
  /**
   * Stop renewing once a handler has held one message this long. A
   * handler that hangs then loses its lease like a dead consumer's would,
   * so the message is reclaimed (and, once its attempts are spent,
   * dead-lettered) rather than held — and its ordering key with it — for
   * as long as the process lives. Default: no cap.
   */
  maxHoldMs?: number;
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

  /** Renew `event`'s lease on a timer until the returned stop is called. */
  function keepLease(event: M): () => void {
    const { extend, extendEveryMs } = deps;
    if (!extend || !extendEveryMs || extendEveryMs <= 0) return () => {};
    const heldSince = Date.now();
    let renewing = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (renewing || stopped) return;
      if (deps.maxHoldMs !== undefined && Date.now() - heldSince >= deps.maxHoldMs) {
        stop();
        logger.warn(
          'event {eventId} ({source}/{type}) has been held for over {maxHoldMs}ms; its lease is no longer renewed, so another consumer may reclaim it',
          {
            component,
            eventId: event.id,
            source: event.source,
            type: event.type,
            maxHoldMs: deps.maxHoldMs,
          }
        );
        return;
      }
      renewing = true;
      extend(event)
        .then((held) => {
          if (held || stopped) return;
          stop();
          logger.warn(
            'event {eventId} ({source}/{type}) lost its lease while being handled; another consumer may be running it too',
            {
              component,
              eventId: event.id,
              source: event.source,
              type: event.type,
            }
          );
        })
        .catch((error: unknown) => {
          // A database blip: the next tick tries again, well inside the lease.
          logger.warn(
            'the lease on event {eventId} was not renewed this tick; the next tick tries again: {error}',
            {
              component,
              eventId: event.id,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        })
        .finally(() => {
          renewing = false;
        });
    }, extendEveryMs);
    // Never the reason a stopping process stays up.
    timer.unref?.();
    function stop(): void {
      stopped = true;
      clearInterval(timer);
    }
    return stop;
  }

  async function processOne(): Promise<boolean> {
    const event = await deps.claim();
    if (!event) return false;

    // Claiming was previously silent on success — the only way to tell a
    // message was ever picked up was the absence of a failure log, which
    // looks identical to "never claimed at all". This line disambiguates.
    logger.debug('claimed event {eventId} ({source}/{type}) on attempt {attempts}', {
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
        'no handler is registered for {source}/{type}; event {eventId} (attempt {attempts}) was marked {status}',
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

    // Renewed only while the handler runs: settling is the end of the hold.
    const stopRenewing = keepLease(event);
    try {
      const resolution = await handler(event);
      stopRenewing();
      const outcome = resolution === 'skipped' ? 'skipped' : 'processed';
      await deps.complete(event, outcome);
      logger.debug('completed event {eventId} ({source}/{type}): {outcome}', {
        component,
        eventId: event.id,
        source: event.source,
        type: event.type,
        outcome,
      });
    } catch (error) {
      stopRenewing();
      if (error instanceof MessageReleased && deps.release) {
        await deps.release(event);
        logger.warn(
          'event {eventId} ({source}/{type}) was released back to the queue on attempt {attempts}, to be picked up at once: {reason}',
          {
            component,
            eventId: event.id,
            source: event.source,
            type: event.type,
            attempts: event.attempts,
            reason: error.message,
          }
        );
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      const disposition = await deps.fail(event, message);
      logger.error(
        'event {eventId} ({source}/{type}) failed on attempt {attempts} and was marked {status}: {error}',
        {
          component,
          eventId: event.id,
          source: event.source,
          type: event.type,
          attempts: event.attempts,
          error: message,
          status: disposition.status,
          stack: error instanceof Error ? error.stack : undefined,
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
        logger.error(
          'the queue could not be claimed or settled (a database problem, not an event); backing off, then trying again: {error}',
          {
            component,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
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
 * A wake a consumer can wait on instead of its idle poll: the memory data
 * store's queue notify (@renkei/db's QueueSignal), for a consumer that
 * shares a process with its producers. `version` moves on every wake.
 */
export interface LoopWake {
  readonly version: number;
  wait(since: number, timeoutMs: number): Promise<void>;
}

/**
 * The `claim` and `sleep` of a loop that wakes on `wake`: an idle sleep
 * returns as soon as something was enqueued since the claim that found
 * nothing (the version read just before it), and otherwise lasts as long
 * as it would have — so a message whose retry delay runs out is still
 * picked up by the poll. The short sleep between busy claims stays a timer.
 */
export function wakeOnSignal<M>(
  wake: LoopWake,
  claim: () => Promise<M | null>,
  busyDelayMs = BUSY_DELAY_MS
): { claim: () => Promise<M | null>; sleep: (ms: number) => Promise<void> } {
  let seen = wake.version;
  return {
    claim: () => {
      seen = wake.version;
      return claim();
    },
    sleep: (ms) => (ms <= busyDelayMs ? defaultSleep(ms) : wake.wait(seen, ms)),
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
    logger.debug(`the ${label} sweep is starting`, { component });
    try {
      await sweep();
      logger.debug(`the ${label} sweep finished`, { component });
    } catch (error) {
      logger.error(`the ${label} sweep failed; the next pass runs in ${intervalMs}ms: {error}`, {
        component,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  // The organization's log level (admin → Settings → Data & logs) must be
  // debug for the two lines above to actually show; it defaults to info.
  logger.debug(`the ${label} sweep is scheduled every ${intervalMs}ms, with a first pass now`, {
    component,
  });
  void tick(); // first pass at boot, concurrent with event processing starting up
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
