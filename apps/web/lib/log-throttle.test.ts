/**
 * Rationing a log line that would otherwise repeat thousands of times.
 * What must hold: the first one speaks, the rest are silent, the window
 * genuinely reopens, and the suppressed count is reported — a flood that
 * looks like three isolated events is worse than no log at all.
 */

import { resetLogThrottle, throttleLog } from './log-throttle';

beforeEach(() => resetLogThrottle());

describe('throttleLog', () => {
  it('lets the first through and silences the rest of the window', () => {
    const now = 1_000_000;
    expect(throttleLog('k', 60_000, now).log).toBe(true);
    expect(throttleLog('k', 60_000, now + 1).log).toBe(false);
    expect(throttleLog('k', 60_000, now + 59_000).log).toBe(false);
  });

  it('reports how many it swallowed when the window reopens', () => {
    const now = 1_000_000;
    throttleLog('k', 60_000, now);
    for (let i = 0; i < 500; i += 1) throttleLog('k', 60_000, now + 100 + i);
    const next = throttleLog('k', 60_000, now + 60_001);
    expect(next.log).toBe(true);
    // The count is what turns "an occasional warning" into "this is a flood".
    expect(next.suppressed).toBe(500);
  });

  it('starts a clean count after each emitted line', () => {
    const now = 1_000_000;
    throttleLog('k', 60_000, now);
    throttleLog('k', 60_000, now + 1);
    expect(throttleLog('k', 60_000, now + 60_001).suppressed).toBe(1);
    expect(throttleLog('k', 60_000, now + 120_002).suppressed).toBe(0);
  });

  it('meters each key on its own', () => {
    const now = 1_000_000;
    expect(throttleLog('a', 60_000, now).log).toBe(true);
    expect(throttleLog('b', 60_000, now).log).toBe(true);
    expect(throttleLog('a', 60_000, now).log).toBe(false);
  });
});
