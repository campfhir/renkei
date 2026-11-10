/**
 * Stopping one sub-agent from outside its loop: the row is marked, and a
 * loop running in this process is aborted at once.
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { stopSubagent, watchSubagentStop } from './subagent-stops';

const CHAT = '00000000-0000-4000-8000-00000000c4a7';

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

describe('stopping a sub-agent', () => {
  it('aborts the loop working here, and only that one', async () => {
    const mine = new AbortController();
    const other = new AbortController();
    const unwatch = watchSubagentStop(CHAT, 'tu-1', mine);
    watchSubagentStop(CHAT, 'tu-2', other);
    expect(await stopSubagent(CHAT, 'tu-1', 'stopped by Ann')).toBe(true);
    expect(mine.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    unwatch();
  });

  it('answers false when nothing is left to stop', async () => {
    const done = new AbortController();
    watchSubagentStop(CHAT, 'tu-3', done)();
    expect(await stopSubagent(CHAT, 'tu-3', 'stopped by Ann')).toBe(false);
    expect(done.signal.aborted).toBe(false);
  });

  it('a loop that has finished does not take a newer one of the same call off the list', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const unwatchFirst = watchSubagentStop(CHAT, 'tu-4', first);
    watchSubagentStop(CHAT, 'tu-4', second);
    unwatchFirst();
    expect(await stopSubagent(CHAT, 'tu-4', 'stopped by Ann')).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
