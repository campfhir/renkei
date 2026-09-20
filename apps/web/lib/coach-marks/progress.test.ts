import { applyCoachMarkEvent, parseCoachMarkRecord, type CoachMarkRecord } from './progress';
import { tourById } from './tours';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T09:05:00.000Z';
const T2 = '2026-03-02T09:00:00.000Z';

const record = (over: Partial<CoachMarkRecord>): CoachMarkRecord => ({
  tourId: 'welcome',
  version: 1,
  event: 'viewed',
  step: 0,
  stepsTotal: 6,
  ...over,
});

describe('parseCoachMarkRecord', () => {
  const welcome = tourById('welcome');
  const total = welcome?.steps.length ?? 0;

  it('accepts a body naming a real tour and a real event', () => {
    expect(parseCoachMarkRecord({ tourId: 'welcome', version: 1, event: 'step', step: 2 })).toEqual(
      { tourId: 'welcome', version: 1, event: 'step', step: 2, stepsTotal: total }
    );
  });

  it('rejects anything else', () => {
    expect(parseCoachMarkRecord(null)).toBeNull();
    expect(parseCoachMarkRecord('welcome')).toBeNull();
    expect(parseCoachMarkRecord({ tourId: 'nope', event: 'viewed' })).toBeNull();
    expect(parseCoachMarkRecord({ tourId: 'welcome', event: 'finished' })).toBeNull();
    expect(parseCoachMarkRecord({ event: 'viewed' })).toBeNull();
  });

  it('clamps the step and the version to what the registry has', () => {
    const parsed = parseCoachMarkRecord({
      tourId: 'welcome',
      version: 99,
      event: 'step',
      step: 500,
    });
    expect(parsed?.step).toBe(total - 1);
    expect(parsed?.version).toBe(welcome?.version);
    expect(parseCoachMarkRecord({ tourId: 'welcome', event: 'viewed', step: -1 })?.step).toBe(0);
    expect(parseCoachMarkRecord({ tourId: 'welcome', event: 'viewed', step: 'two' })?.step).toBe(0);
  });
});

describe('applyCoachMarkEvent', () => {
  it('starts a fresh row on viewed', () => {
    const next = applyCoachMarkEvent(null, record({ event: 'viewed' }), T0);
    expect(next).toMatchObject({
      tourId: 'welcome',
      version: 1,
      status: 'viewed',
      stepReached: 0,
      stepsTotal: 6,
      viewCount: 1,
      completedCount: 0,
      dismissedCount: 0,
      firstViewedAt: T0,
      lastViewedAt: T0,
      completedAt: null,
      dismissedAt: null,
    });
  });

  it('only ever raises the step reached', () => {
    const started = applyCoachMarkEvent(null, record({ event: 'viewed' }), T0);
    const forward = applyCoachMarkEvent(started, record({ event: 'step', step: 3 }), T1);
    expect(forward.stepReached).toBe(3);
    const back = applyCoachMarkEvent(forward, record({ event: 'step', step: 1 }), T1);
    expect(back.stepReached).toBe(3);
    expect(back.status).toBe('viewed');
    expect(back.viewCount).toBe(1);
  });

  it('settles a pass on completed, at the last step', () => {
    const started = applyCoachMarkEvent(null, record({ event: 'viewed' }), T0);
    const done = applyCoachMarkEvent(started, record({ event: 'completed', step: 5 }), T1);
    expect(done).toMatchObject({
      status: 'completed',
      stepReached: 5,
      completedCount: 1,
      completedAt: T1,
      dismissedCount: 0,
      firstViewedAt: T0,
    });
  });

  it('settles a pass on dismissed, remembering how far they got', () => {
    const started = applyCoachMarkEvent(null, record({ event: 'viewed' }), T0);
    const mid = applyCoachMarkEvent(started, record({ event: 'step', step: 2 }), T1);
    const skipped = applyCoachMarkEvent(mid, record({ event: 'dismissed', step: 2 }), T1);
    expect(skipped).toMatchObject({
      status: 'dismissed',
      stepReached: 2,
      dismissedCount: 1,
      dismissedAt: T1,
      completedCount: 0,
    });
  });

  it('keeps the counters across a replay, and the first-viewed time', () => {
    const started = applyCoachMarkEvent(null, record({ event: 'viewed' }), T0);
    const done = applyCoachMarkEvent(started, record({ event: 'completed', step: 5 }), T1);
    const replay = applyCoachMarkEvent(done, record({ event: 'viewed' }), T2);
    expect(replay).toMatchObject({
      status: 'viewed',
      stepReached: 0,
      viewCount: 2,
      completedCount: 1,
      completedAt: T1,
      firstViewedAt: T0,
      lastViewedAt: T2,
    });
    const skipped = applyCoachMarkEvent(replay, record({ event: 'dismissed', step: 1 }), T2);
    expect(skipped).toMatchObject({ status: 'dismissed', completedCount: 1, dismissedCount: 1 });
  });

  it('records a new edition when the tour was reworked', () => {
    const old = applyCoachMarkEvent(null, record({ event: 'completed', version: 1 }), T0);
    const fresh = applyCoachMarkEvent(
      old,
      record({ event: 'viewed', version: 2, stepsTotal: 4 }),
      T2
    );
    expect(fresh.version).toBe(2);
    expect(fresh.stepsTotal).toBe(4);
  });

  it('opens a pass from whatever arrives first when the viewed report was lost', () => {
    const next = applyCoachMarkEvent(null, record({ event: 'step', step: 2 }), T0);
    expect(next).toMatchObject({ status: 'viewed', viewCount: 1, stepReached: 2 });
    const done = applyCoachMarkEvent(null, record({ event: 'completed', step: 5 }), T0);
    expect(done).toMatchObject({ status: 'completed', viewCount: 1, completedCount: 1 });
  });

  it('does not let a late step report reopen a settled pass', () => {
    const started = applyCoachMarkEvent(null, record({ event: 'viewed' }), T0);
    const done = applyCoachMarkEvent(started, record({ event: 'completed', step: 5 }), T1);
    const late = applyCoachMarkEvent(done, record({ event: 'step', step: 4 }), T1);
    expect(late.status).toBe('completed');
    expect(late.stepReached).toBe(5);
  });
});
