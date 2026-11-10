import { STUCK_AFTER_MS, isStuckRun, stuckRunIds } from './stuck';

const NOW = Date.parse('2026-11-08T20:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60_000;

const run = (id: string, status: string, ageMs: number, resumedAgoMs?: number) => ({
  id,
  status,
  createdAt: ago(ageMs),
  resumedAt: resumedAgoMs === undefined ? null : ago(resumedAgoMs),
});

describe('a stuck run', () => {
  it('is one queued or running past the two-hour horizon', () => {
    expect(isStuckRun(run('a', 'queued', 3 * HOUR), NOW)).toBe(true);
    expect(isStuckRun(run('b', 'running', 5 * 24 * HOUR), NOW)).toBe(true);
  });

  it('is not one still inside the horizon, right up to it', () => {
    expect(isStuckRun(run('a', 'queued', STUCK_AFTER_MS), NOW)).toBe(false);
  });

  it('is never one waiting on a person, or one that has finished', () => {
    for (const status of ['waiting', 'succeeded', 'failed', 'canceled', 'stopped']) {
      expect(isStuckRun(run('a', status, 9 * 24 * HOUR), NOW)).toBe(false);
    }
  });

  it('counts from the latest resume: a run picked back up an hour ago is not stuck', () => {
    expect(isStuckRun(run('a', 'running', 7 * 24 * HOUR, HOUR), NOW)).toBe(false);
    expect(isStuckRun(run('b', 'running', 7 * 24 * HOUR, 3 * HOUR), NOW)).toBe(true);
  });

  it('picks the stuck ones out of a list, keeping its order', () => {
    expect(
      stuckRunIds(
        [
          run('new-queued', 'queued', HOUR),
          run('old-queued', 'queued', 3 * HOUR),
          run('waiting', 'waiting', 30 * HOUR),
          run('old-running', 'running', 9 * HOUR),
        ],
        NOW
      )
    ).toEqual(['old-queued', 'old-running']);
  });
});
