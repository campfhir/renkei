import { clearHandlerCache, getHandler, handlerCacheSize, setHandler } from './handler-cache';

const handler = (name: string) => async () => new Response(name);

beforeEach(() => clearHandlerCache());

describe('handler cache', () => {
  it('returns what was stored', async () => {
    setHandler('a', handler('one'));
    const found = getHandler('a');
    expect(found).toBeDefined();
    await expect((await found!(new Request('https://x/'))).text()).resolves.toBe('one');
  });

  it('misses on an unknown key', () => {
    expect(getHandler('nope')).toBeUndefined();
  });

  it('expires an entry once its TTL passes', () => {
    jest.useFakeTimers();
    try {
      setHandler('a', handler('one'));
      jest.advanceTimersByTime(30 * 60_000 - 1);
      expect(getHandler('a')).toBeDefined();
      jest.advanceTimersByTime(2);
      expect(getHandler('a')).toBeUndefined();
      // The expired entry is dropped, not merely hidden — otherwise the map
      // still grows without bound, which is half of what this cache fixes.
      expect(handlerCacheSize()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays bounded, evicting the oldest first', () => {
    for (let i = 0; i < 600; i += 1) setHandler(`k${i}`, handler(String(i)));

    expect(handlerCacheSize()).toBe(500);
    expect(getHandler('k0')).toBeUndefined();
    expect(getHandler('k599')).toBeDefined();
  });

  it('spares an entry that keeps being read', () => {
    setHandler('keepme', handler('keepme'));
    for (let i = 0; i < 400; i += 1) {
      setHandler(`k${i}`, handler(String(i)));
      // Reading it re-inserts it, which is what makes eviction LRU rather
      // than least-recently-created.
      expect(getHandler('keepme')).toBeDefined();
    }
    for (let i = 400; i < 600; i += 1) setHandler(`k${i}`, handler(String(i)));

    expect(getHandler('keepme')).toBeDefined();
  });

  it('replaces rather than duplicates on the same key', () => {
    setHandler('a', handler('first'));
    setHandler('a', handler('second'));
    expect(handlerCacheSize()).toBe(1);
  });
});
