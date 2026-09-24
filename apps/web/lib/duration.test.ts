import { formatDurationMs } from './duration';

describe('formatDurationMs', () => {
  it('reads as a person would say it at each scale', () => {
    expect(formatDurationMs(0)).toBe('0.0s');
    expect(formatDurationMs(420)).toBe('0.4s');
    expect(formatDurationMs(999)).toBe('1.0s');
    expect(formatDurationMs(1_400)).toBe('1s');
    expect(formatDurationMs(12_600)).toBe('13s');
    expect(formatDurationMs(65_000)).toBe('1m 05s');
    expect(formatDurationMs(59.6 * 60_000)).toBe('59m 36s');
    expect(formatDurationMs(2 * 3_600_000 + 5 * 60_000)).toBe('2h 05m');
  });

  it('never goes negative', () => {
    expect(formatDurationMs(-50)).toBe('0.0s');
  });
});
