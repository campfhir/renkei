/**
 * The loop's release path: a handler that throws MessageReleased hands
 * the message back through `release` — no fail, no attempt spent — and
 * a loop without `release` falls back to failing it. `stopping` is what
 * a handler polls to decide to do that.
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
