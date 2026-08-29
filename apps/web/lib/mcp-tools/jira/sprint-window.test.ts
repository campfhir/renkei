import { sprintProgress, sprintWindow } from './sprint-window';

describe('sprintWindow', () => {
  it('reads a full sprint as a span', () => {
    expect(
      sprintWindow({ startDate: '2026-08-18T10:00:00.000Z', endDate: '2026-09-01T10:00:00.000Z' })
    ).toBe('2026-08-18 → 2026-09-01');
  });

  it('says which half it has when only one date is set', () => {
    // A board holds future sprints with a start and no end all the time,
    // and "starts Monday" is the answer someone planning against it needs.
    expect(sprintWindow({ startDate: '2026-08-18T10:00:00.000Z' })).toBe('starts 2026-08-18');
    expect(sprintWindow({ endDate: '2026-09-01T10:00:00.000Z' })).toBe('ends 2026-09-01');
  });

  it('says the dates are unset rather than rendering an empty span', () => {
    expect(sprintWindow({})).toBe('dates not set');
    expect(sprintWindow({ startDate: null, endDate: undefined })).toBe('dates not set');
  });
});

describe('sprintProgress', () => {
  const sprint = { startDate: '2026-08-18T10:00:00.000Z', endDate: '2026-09-01T10:00:00.000Z' };

  it('counts the days left, rounding up the day in progress', () => {
    expect(sprintProgress(sprint, new Date('2026-08-21T00:00:00.000Z'))).toBe('12d left');
  });

  it('counts back from a sprint whose end has passed', () => {
    expect(sprintProgress(sprint, new Date('2026-09-05T10:00:00.000Z'))).toBe('ended 4d ago');
  });

  it('stays silent rather than guess from half a window', () => {
    expect(sprintProgress({ startDate: sprint.startDate }, new Date())).toBe('');
    expect(sprintProgress({ startDate: 'not a date', endDate: sprint.endDate }, new Date())).toBe(
      ''
    );
    // An end at or before the start is a misconfigured sprint, not 0 days.
    expect(
      sprintProgress({ startDate: sprint.endDate, endDate: sprint.startDate }, new Date())
    ).toBe('');
  });
});
