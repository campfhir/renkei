import { defaultLogWindow, describeWindow, DEFAULT_WINDOW_DAYS, NO_LOWER_BOUND } from './window';

describe('defaultLogWindow', () => {
  it('starts DEFAULT_WINDOW_DAYS back and leaves the end open', () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const window = defaultLogWindow(now);

    expect(window.start).toBe('2026-07-29T12:00:00.000Z');
    expect(window.end).toBeNull();
    expect(DEFAULT_WINDOW_DAYS).toBe(7);
  });

  it('is a real bound, not the absence of one', () => {
    // The bug this exists for: no bound means the adapter substitutes yesterday,
    // while the picker shows nothing at all.
    expect(defaultLogWindow().start).not.toBeNull();
  });
});

describe('NO_LOWER_BOUND', () => {
  it('is early enough to mean every record', () => {
    expect(new Date(NO_LOWER_BOUND).getTime()).toBe(0);
  });
});

describe('describeWindow', () => {
  it('names what is being searched, so an empty result is explainable', () => {
    expect(describeWindow({ start: null, end: null })).toBe('all time');
    expect(describeWindow({ start: '2026-07-29T12:00:00.000Z', end: null })).toBe(
      'since 2026-07-29'
    );
    expect(describeWindow({ start: null, end: '2026-08-05T00:00:00.000Z' })).toBe(
      'up to 2026-08-05'
    );
    expect(
      describeWindow({ start: '2026-07-29T12:00:00.000Z', end: '2026-08-05T00:00:00.000Z' })
    ).toBe('2026-07-29 to 2026-08-05');
  });
});
