/**
 * The extracted event loop's claim/complete/fail contract — the machinery
 * both worker processes share (see multistream.test.ts for the two lanes
 * running concurrently).
 */

jest.mock('./logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { createEventLoop } from './loop';
import type { ClaimedEvent, Disposition } from './queue';

function event(over: Partial<ClaimedEvent> = {}): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'webex',
    type: 'messages.created',
    payload: {},
    attempts: 1,
    ...over,
  };
}

const retryDisposition: Disposition = { status: 'pending', delaySeconds: 30 };

describe('createEventLoop.processOne', () => {
  it('claims, handles, completes', async () => {
    const handled: string[] = [];
    const completed: string[] = [];
    const loop = createEventLoop({
      claim: async () => event(),
      complete: async (e) => {
        completed.push(e.id);
      },
      fail: async () => retryDisposition,
      handlerFor: () => async (e) => {
        handled.push(e.id);
      },
    });
    expect(await loop.processOne()).toBe(true);
    expect(handled).toEqual(['evt-1']);
    expect(completed).toEqual(['evt-1']);
  });

  it('returns false on an empty queue', async () => {
    const loop = createEventLoop({
      claim: async () => null,
      complete: async () => {},
      fail: async () => retryDisposition,
      handlerFor: () => undefined,
    });
    expect(await loop.processOne()).toBe(false);
  });

  it('fails the event when its handler throws, and does not complete it', async () => {
    const failures: string[] = [];
    let completed = false;
    const loop = createEventLoop({
      claim: async () => event(),
      complete: async () => {
        completed = true;
      },
      fail: async (_e, error) => {
        failures.push(error);
        return retryDisposition;
      },
      handlerFor: () => async () => {
        throw new Error('boom');
      },
    });
    await loop.processOne();
    expect(failures).toEqual(['boom']);
    expect(completed).toBe(false);
  });

  it('fails an event that has no registered handler', async () => {
    const failures: string[] = [];
    const loop = createEventLoop({
      claim: async () => event({ source: 'other', type: 'unknown' }),
      complete: async () => {},
      fail: async (_e, error) => {
        failures.push(error);
        return retryDisposition;
      },
      handlerFor: () => undefined,
    });
    await loop.processOne();
    expect(failures).toEqual(['no handler registered for other/unknown']);
  });
});

describe('createEventLoop.run', () => {
  it('polls until stopped, surviving claim errors', async () => {
    let claims = 0;
    const loop = createEventLoop({
      claim: async () => {
        claims += 1;
        if (claims === 2) throw new Error('db hiccup');
        return null;
      },
      complete: async () => {},
      fail: async () => retryDisposition,
      handlerFor: () => undefined,
      busyDelayMs: 1,
      idleDelayMs: 1,
    });
    const running = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    loop.stop();
    await running;
    // Kept claiming after the thrown claim — the error was contained.
    expect(claims).toBeGreaterThan(3);
  });
});
