/**
 * The loop's release path: a handler that throws MessageReleased hands
 * the message back through `release` — no fail, no attempt spent — and
 * a loop without `release` falls back to failing it. `stopping` is what
 * a handler polls to decide to do that. And lease renewal: the loop keeps
 * a running handler's claim alive, and stops once it settles, loses the
 * lease, or has held the message past `maxHoldMs`.
 */

import {
  createEventLoop,
  MessageReleased,
  wakeOnSignal,
  type EventLoop,
  type LoopMessage,
} from './index';

const logger = { debug() {}, warn() {}, error() {} };

function message(id = 'm1'): LoopMessage {
  return { id, source: 'agents', type: 'run', attempts: 1 };
}

describe('createEventLoop release', () => {
  it('releases a message whose handler threw MessageReleased instead of failing it', async () => {
    const released: string[] = [];
    const failed: string[] = [];
    const completed: string[] = [];
    const loop = createEventLoop<LoopMessage>({
      claim: async () => message(),
      complete: async (m) => {
        completed.push(m.id);
      },
      fail: async (m) => {
        failed.push(m.id);
        return { status: 'retry', delaySeconds: 30 };
      },
      release: async (m) => {
        released.push(m.id);
      },
      handlerFor: () => async () => {
        throw new MessageReleased('stopping');
      },
      logger,
    });
    expect(await loop.processOne()).toBe(true);
    expect(released).toEqual(['m1']);
    expect(failed).toEqual([]);
    expect(completed).toEqual([]);
  });

  it('fails the message when the queue offers no release', async () => {
    const failed: string[] = [];
    const loop = createEventLoop<LoopMessage>({
      claim: async () => message(),
      complete: async () => {},
      fail: async (m) => {
        failed.push(m.id);
        return { status: 'retry', delaySeconds: 30 };
      },
      handlerFor: () => async () => {
        throw new MessageReleased('stopping');
      },
      logger,
    });
    await loop.processOne();
    expect(failed).toEqual(['m1']);
  });

  it('reports stopping once stop() was called, and run() then winds down', async () => {
    let claims = 0;
    const stops: boolean[] = [];
    // claim() reads `loop` only once the loop is running, well after this binding exists.
    const loop: EventLoop = createEventLoop<LoopMessage>({
      claim: async () => {
        claims += 1;
        stops.push(loop.stopping);
        // The third idle pass is where the signal lands.
        if (claims === 3) loop.stop();
        return null;
      },
      complete: async () => {},
      fail: async () => ({ status: 'dead' }),
      handlerFor: () => undefined,
      logger,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });
    expect(loop.stopping).toBe(false);
    await loop.run();
    expect(loop.stopping).toBe(true);
    expect(claims).toBe(3);
    expect(stops).toEqual([false, false, false]);
  });
});

describe('createEventLoop lease renewal', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** A handler that stays in flight until `finish` is called. */
  function heldHandler() {
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { handler: async () => done, finish: () => finish() };
  }

  /** Let the renewal timer's promise chain settle after advancing time. */
  async function advance(ms: number) {
    await jest.advanceTimersByTimeAsync(ms);
  }

  it('renews the lease on a timer while the handler runs, and stops once it is done', async () => {
    jest.useFakeTimers();
    const held = heldHandler();
    const extended: string[] = [];
    const completed: string[] = [];
    const loop = createEventLoop<LoopMessage>({
      claim: async () => message(),
      complete: async (m) => {
        completed.push(m.id);
      },
      fail: async () => ({ status: 'dead' }),
      extend: async (m) => {
        extended.push(m.id);
        return true;
      },
      extendEveryMs: 1_000,
      handlerFor: () => held.handler,
      logger,
    });
    const processing = loop.processOne();
    await advance(3_500);
    expect(extended).toEqual(['m1', 'm1', 'm1']);

    held.finish();
    await processing;
    expect(completed).toEqual(['m1']);
    await advance(5_000);
    expect(extended).toHaveLength(3);
  });

  it('stops renewing once the lease is reported lost', async () => {
    jest.useFakeTimers();
    const held = heldHandler();
    let calls = 0;
    const warnings: string[] = [];
    const loop = createEventLoop<LoopMessage>({
      claim: async () => message(),
      complete: async () => {},
      fail: async () => ({ status: 'dead' }),
      extend: async () => {
        calls += 1;
        return false;
      },
      extendEveryMs: 1_000,
      handlerFor: () => held.handler,
      logger: { ...logger, warn: (line: string) => warnings.push(line) },
    });
    const processing = loop.processOne();
    await advance(4_500);
    expect(calls).toBe(1);
    expect(warnings.some((line) => line.includes('lost its lease'))).toBe(true);
    held.finish();
    await processing;
  });

  it('stops renewing a handler that has held its message past maxHoldMs', async () => {
    jest.useFakeTimers();
    const held = heldHandler();
    let calls = 0;
    const loop = createEventLoop<LoopMessage>({
      claim: async () => message(),
      complete: async () => {},
      fail: async () => ({ status: 'dead' }),
      extend: async () => {
        calls += 1;
        return true;
      },
      extendEveryMs: 1_000,
      maxHoldMs: 2_500,
      handlerFor: () => held.handler,
      logger,
    });
    const processing = loop.processOne();
    await advance(10_000);
    // Renewed at 1s and 2s; the 3s tick is past the hold and ends renewal.
    expect(calls).toBe(2);
    held.finish();
    await processing;
  });

  it('stops renewing when the handler fails, before the message is failed', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const failed: string[] = [];
    const loop = createEventLoop<LoopMessage>({
      claim: async () => message(),
      complete: async () => {},
      fail: async (m) => {
        failed.push(m.id);
        return { status: 'retry', delaySeconds: 60 };
      },
      extend: async () => {
        calls += 1;
        return true;
      },
      extendEveryMs: 1_000,
      handlerFor: () => async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        throw new Error('model unavailable');
      },
      logger,
    });
    const processing = loop.processOne();
    await advance(1_500);
    await processing;
    expect(failed).toEqual(['m1']);
    await advance(5_000);
    expect(calls).toBe(1);
  });

  it('never renews without extendEveryMs', async () => {
    jest.useFakeTimers();
    const held = heldHandler();
    let calls = 0;
    const loop = createEventLoop<LoopMessage>({
      claim: async () => message(),
      complete: async () => {},
      fail: async () => ({ status: 'dead' }),
      extend: async () => {
        calls += 1;
        return true;
      },
      handlerFor: () => held.handler,
      logger,
    });
    const processing = loop.processOne();
    await advance(10_000);
    expect(calls).toBe(0);
    held.finish();
    await processing;
  });
});

describe('wakeOnSignal', () => {
  function fakeWake() {
    const waits: { since: number; ms: number }[] = [];
    const wake = {
      version: 0,
      wait: async (since: number, ms: number) => {
        waits.push({ since, ms });
      },
    };
    return { wake, waits };
  }

  it('waits on the version read just before the claim that found nothing', async () => {
    const { wake, waits } = fakeWake();
    const wakeable = wakeOnSignal(wake, async () => {
      // A message lands while the claim is in flight.
      wake.version = 7;
      return null;
    });
    wake.version = 3;
    await wakeable.claim();
    await wakeable.sleep(1_000);
    expect(waits).toEqual([{ since: 3, ms: 1_000 }]);
  });

  it('keeps the short sleep between busy claims a plain timer', async () => {
    const { wake, waits } = fakeWake();
    const wakeable = wakeOnSignal(wake, async () => 'message');
    await wakeable.claim();
    await wakeable.sleep(1);
    expect(waits).toEqual([]);
  });
});
