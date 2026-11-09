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
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;

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
   * Stop renewing, and stop waiting, once a handler has held one message
   * this long. A handler that hangs then loses its lease like a dead
   * consumer's would, so the message is reclaimed (and, once its attempts
   * are spent, dead-lettered) rather than held — and its ordering key
   * with it — for as long as the process lives; and the loop goes on to
   * claim the next message instead of sitting behind the hung one for as
   * long as the process lives. Should the handler settle after all, its
   * outcome is still put to the queue, which applies it only while this
   * delivery holds the lease. Default: no cap.
   */
  maxHoldMs?: number;
  /**
   * Stop waiting on a claim that has not answered in this long — a query
   * on a connection the network dropped without a word hangs for good —
   * and claim again, on a fresh connection. A message the late claim then
   * yields is handed back untouched (`release`). Default: five minutes;
   * 0 waits for ever.
   */
  claimTimeoutMs?: number;
  /**
   * How often a running loop says, at debug, that it is alive and what it
   * has done since it last said so — the line that tells a consumer that
   * is idle from one that is stuck. Default: five minutes; 0 says nothing.
   */
  heartbeatMs?: number;
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

/** How a wait ended: the work settled (well or badly), or the deadline came first. */
type Waited<T> =
  { done: true; ok: true; value: T } | { done: true; ok: false; error: unknown } | { done: false };

/**
 * `work` as it settles, or `{ done: false }` once `ms` has passed without
 * it — the work itself is left running. No deadline when `ms` is unset or
 * 0. The result never rejects: a rejection comes back as `ok: false`, so
 * a caller that gives up on the work is not left holding an unhandled
 * rejection, and one that waits rethrows it.
 */
async function awaitOrAbandon<T>(work: Promise<T>, ms: number | undefined): Promise<Waited<T>> {
  const settled = work.then(
    (value) => ({ done: true, ok: true, value }) as const,
    (error: unknown) => ({ done: true, ok: false, error }) as const
  );
  if (ms === undefined || ms <= 0) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createEventLoop<M extends LoopMessage>(deps: EventLoopDeps<M>): EventLoop {
  const busyDelayMs = deps.busyDelayMs ?? BUSY_DELAY_MS;
  const idleDelayMs = deps.idleDelayMs ?? IDLE_DELAY_MS;
  const claimTimeoutMs = deps.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const component = deps.label ?? 'worker/loop';
  const logger = deps.logger;
  let running = true;

  /** Renew `event`'s lease on a timer until the returned stop is called. */
  function keepLease(event: M): () => void {
    const { extend, extendEveryMs } = deps;
    if (!extend || !extendEveryMs || extendEveryMs <= 0) return () => {};
    let renewing = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (renewing || stopped) return;
      renewing = true;
      extend(event)
        .then((held) => {
          if (held || stopped) return;
          stop();
          logger.warn('event {eventId} ({source}/{type}) lost its lease while being handled', {
            component,
            eventId: event.id,
            source: event.source,
            type: event.type,
          });
        })
        .catch((error: unknown) => {
          // A database blip: the next tick tries again, well inside the lease.
          logger.warn('event {eventId} lease renewal failed: {error}', {
            component,
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          });
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

  function eventFields(event: M): Record<string, unknown> {
    return {
      component,
      eventId: event.id,
      source: event.source,
      type: event.type,
      attempts: event.attempts,
    };
  }

  /** Ack a handled message. */
  async function settle(event: M, resolution: HandlerResolution): Promise<'processed' | 'skipped'> {
    const outcome = resolution === 'skipped' ? 'skipped' : 'processed';
    await deps.complete(event, outcome);
    return outcome;
  }

  /**
   * Nack a message whose handler threw: hand it back if the handler was
   * stopping on purpose, else fail it per policy. Returns what was done.
   */
  async function settleError(
    event: M,
    error: unknown
  ): Promise<{ status: 'released' } | LoopDisposition> {
    if (error instanceof MessageReleased && deps.release) {
      await deps.release(event);
      return { status: 'released' };
    }
    return deps.fail(event, error instanceof Error ? error.message : String(error));
  }

  /**
   * A handler the loop stopped waiting for, settled when it does finish:
   * its outcome goes to the queue as it would have, and the queue applies
   * it only while this delivery still holds the lease (a reclaimed message
   * is the next consumer's). What matters is that it is heard, not lost.
   */
  function settleLate(event: M, work: Promise<HandlerResolution>): void {
    work
      .then(
        async (resolution) => {
          const outcome = await settle(event, resolution);
          logger.warn(
            'event {eventId} ({source}/{type}) finished ({outcome}) after the loop stopped waiting for it',
            { ...eventFields(event), outcome }
          );
        },
        async (error: unknown) => {
          const done = await settleError(event, error);
          logger.warn(
            'event {eventId} ({source}/{type}) failed after the loop stopped waiting for it: {error} → {status}',
            {
              ...eventFields(event),
              error: error instanceof Error ? error.message : String(error),
              status: done.status,
            }
          );
        }
      )
      .catch((error: unknown) => {
        logger.error('event {eventId} could not be settled late: {error}', {
          ...eventFields(event),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * The claim, abandoned when the queue does not answer in
   * `claimTimeoutMs`. Nothing is lost that way: a message the late claim
   * yields is handed back, and a claim that never answers was never going
   * to — but a loop that waited on it would never claim again, while the
   * sweeps beside it ran on, and nothing in the log would say so.
   */
  async function claim(): Promise<M | null> {
    const pending = deps.claim();
    const claimed = await awaitOrAbandon(pending, claimTimeoutMs);
    if (claimed.done) {
      if (claimed.ok) return claimed.value;
      throw claimed.error;
    }
    logger.error(
      'the queue has not answered a claim in {claimTimeoutMs}ms; leaving it and claiming again',
      { component, claimTimeoutMs }
    );
    pending
      .then(async (late) => {
        if (!late) return;
        logger.warn(
          'event {eventId} ({source}/{type}) arrived from a claim the loop had given up on; handing it back',
          eventFields(late)
        );
        if (deps.release) await deps.release(late);
      })
      .catch((error: unknown) => {
        logger.warn('the abandoned claim failed: {error}', {
          component,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return null;
  }

  async function processOne(): Promise<boolean> {
    const event = await claim();
    if (!event) return false;

    // Claiming was previously silent on success — the only way to tell a
    // message was ever picked up was the absence of a failure log, which
    // looks identical to "never claimed at all". This line disambiguates.
    logger.debug(
      'claimed event {eventId} ({source}/{type}), attempt {attempts}',
      eventFields(event)
    );

    const handler = deps.handlerFor(event);
    if (!handler) {
      const disposition = await deps.fail(
        event,
        `no handler registered for ${event.source}/${event.type}`
      );
      logger.warn(
        'no handler for {source}/{type} (event {eventId}, attempt {attempts}) → {status}',
        { ...eventFields(event), status: disposition.status }
      );
      return true;
    }

    // Renewed only while the handler runs: settling is the end of the hold.
    const stopRenewing = keepLease(event);
    const work = handler(event);
    const result = await awaitOrAbandon(work, deps.maxHoldMs);
    stopRenewing();
    if (!result.done) {
      // Held past the cap: the lease is left to lapse so the queue can
      // reclaim the message, and this loop goes on to the next one rather
      // than sitting behind a handler that may never return.
      logger.error(
        'event {eventId} ({source}/{type}) held past {maxHoldMs}ms; no longer waiting for it or renewing its lease',
        { ...eventFields(event), maxHoldMs: deps.maxHoldMs }
      );
      settleLate(event, work);
      return true;
    }
    if (result.ok) {
      const outcome = await settle(event, result.value);
      logger.debug('completed event {eventId} ({outcome})', {
        component,
        eventId: event.id,
        outcome,
      });
      return true;
    }
    const error = result.error;
    const done = await settleError(event, error);
    if (done.status === 'released') {
      logger.warn('event {eventId} ({source}/{type}) released on attempt {attempts}: {reason}', {
        ...eventFields(event),
        reason: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
    logger.error(
      'event {eventId} ({source}/{type}) failed on attempt {attempts}: {error} → {status}',
      {
        ...eventFields(event),
        error: error instanceof Error ? error.message : String(error),
        status: done.status,
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
    return true;
  }

  async function run(): Promise<void> {
    // The heartbeat's tallies: claims made and messages handled since the
    // last line, and when a message was last handled at all.
    let claims = 0;
    let handled = 0;
    let lastHandledAt: number | null = null;
    let lastBeatAt = Date.now();
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
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
      claims += 1;
      if (hadWork) {
        handled += 1;
        lastHandledAt = Date.now();
      }
      if (heartbeatMs > 0 && Date.now() - lastBeatAt >= heartbeatMs) {
        logger.debug(
          'loop alive: {claims} claims, {handled} messages handled since the last line; last message {lastMessageAgoMs}ms ago',
          {
            component,
            claims,
            handled,
            lastMessageAgoMs: lastHandledAt === null ? null : Date.now() - lastHandledAt,
          }
        );
        claims = 0;
        handled = 0;
        lastBeatAt = Date.now();
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
    logger.debug(`${label} sweep starting`, { component });
    try {
      await sweep();
      logger.debug(`${label} sweep finished`, { component });
    } catch (error) {
      logger.error(`${label} sweep error: {error}`, {
        component,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
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
