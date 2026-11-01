import { sizeOf } from './file-caption.model';

describe("a file's size under it", () => {
  it('is in bytes under a kilobyte', () => {
    expect(sizeOf(0)).toBe('0 B');
    expect(sizeOf(1023)).toBe('1023 B');
  });

  it('is in whole kilobytes under a megabyte', () => {
    expect(sizeOf(1024)).toBe('1 KB');
    expect(sizeOf(1536)).toBe('2 KB');
    expect(sizeOf(1024 * 1024 - 1)).toBe('1024 KB');
  });

  it('is in megabytes to a tenth from a megabyte up', () => {
    expect(sizeOf(1024 * 1024)).toBe('1.0 MB');
    expect(sizeOf(2.25 * 1024 * 1024)).toBe('2.3 MB');
  });
});
