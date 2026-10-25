import { formatByteSize, parseByteSize } from './byte-size';

describe('parseByteSize', () => {
  it('reads a unit-suffixed size in binary units', () => {
    expect(parseByteSize('70MB')).toBe(73_400_320);
    expect(parseByteSize('1MB')).toBe(1_048_576);
    expect(parseByteSize('100mb')).toBe(104_857_600);
    expect(parseByteSize('2GB')).toBe(2_147_483_648);
    expect(parseByteSize('512KB')).toBe(524_288);
  });

  it('allows a space before the unit and decimal sizes', () => {
    expect(parseByteSize('70 MB')).toBe(73_400_320);
    expect(parseByteSize('1.5GB')).toBe(1_610_612_736);
  });

  it('reads a bare number as bytes', () => {
    expect(parseByteSize('73400320')).toBe(73_400_320);
    expect(parseByteSize('512B')).toBe(512);
  });

  it('rejects text that is not a size', () => {
    expect(parseByteSize('')).toBeNull();
    expect(parseByteSize('MB')).toBeNull();
    expect(parseByteSize('70 megabytes')).toBeNull();
    expect(parseByteSize('-5MB')).toBeNull();
    expect(parseByteSize('70M')).toBeNull();
  });
});

describe('formatByteSize', () => {
  it('uses the largest unit the count divides into evenly', () => {
    expect(formatByteSize(73_400_320)).toBe('70MB');
    expect(formatByteSize(104_857_600)).toBe('100MB');
    expect(formatByteSize(2_147_483_648)).toBe('2GB');
    expect(formatByteSize(524_288)).toBe('512KB');
  });

  it('falls back to bytes when no unit fits exactly', () => {
    expect(formatByteSize(1_000_000)).toBe('1000000');
    expect(formatByteSize(700)).toBe('700');
  });

  it('round-trips through parseByteSize', () => {
    for (const bytes of [73_400_320, 1_048_576, 2_147_483_648, 1_000_000]) {
      expect(parseByteSize(formatByteSize(bytes))).toBe(bytes);
    }
  });
});
