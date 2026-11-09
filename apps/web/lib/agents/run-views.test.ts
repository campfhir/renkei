import { STUCK_AFTER_MS } from './stuck';
import { RUN_VIEWS, isRunView, runViewFilter, runViewLabel } from './run-views';

const NOW = Date.parse('2026-11-09T12:00:00Z');

describe('the run list’s quick filters', () => {
  it('offers the meta statuses beside the plain ones, in tab order', () => {
    expect(RUN_VIEWS.map(runViewLabel)).toEqual([
      'Succeeded',
      'Failed',
      'Skipped',
      'Waiting for you',
      'Paused: sign in',
      'Running',
      'Queued',
      'Stuck',
      'Canceled',
      'Halted',
    ]);
  });

  it('Stuck is queued or running with its clock started past the horizon', () => {
    expect(runViewFilter('stuck', NOW)).toEqual({
      statuses: ['queued', 'running'],
      clockStartedBefore: new Date(NOW - STUCK_AFTER_MS),
    });
  });

  it('Halted and Canceled split the canceled runs between them', () => {
    expect(runViewFilter('halted', NOW)).toEqual({
      status: 'canceled',
      errorKinds: ['force_halted'],
    });
    expect(runViewFilter('canceled', NOW)).toEqual({
      status: 'canceled',
      excludeErrorKinds: ['force_halted'],
    });
  });

  it('Paused and Waiting split the waiting runs between them', () => {
    expect(runViewFilter('paused', NOW)).toEqual({
      status: 'waiting',
      errorKinds: ['needs-sign-in'],
    });
    expect(runViewFilter('waiting', NOW)).toEqual({
      status: 'waiting',
      excludeErrorKinds: ['needs-sign-in'],
    });
  });

  it('a plain status filters on just that status', () => {
    expect(runViewFilter('failed', NOW)).toEqual({ status: 'failed' });
  });

  it('only knows its own views', () => {
    expect(isRunView('halted')).toBe(true);
    expect(isRunView('terminated')).toBe(false);
    expect(isRunView(undefined)).toBe(false);
  });
});
