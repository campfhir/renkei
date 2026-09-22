import { parseUnifiedDiff } from './diff';
import { unifiedDiff } from './text-diff';

describe('unifiedDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedDiff('a.ts', 'x\ny', 'x\ny')).toBe('');
  });

  it('writes a diff the app’s own parser reads back', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n');
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].join('\n');
    const diff = unifiedDiff('notes.txt', before, after);
    expect(diff).not.toBeNull();
    const files = parseUnifiedDiff(diff!);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('notes.txt');
    expect(files[0].added).toBe(2);
    expect(files[0].deleted).toBe(1);
    // Eight equal lines between the changes is more than twice the context: two hunks.
    expect(files[0].hunks).toHaveLength(2);
  });

  it('keeps one hunk for changes close together', () => {
    const diff = unifiedDiff('x', 'a\nb\nc\nd', 'a\nB\nc\nD');
    const files = parseUnifiedDiff(diff!);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].added).toBe(2);
    expect(files[0].deleted).toBe(2);
  });

  it('handles an insertion at the very end and a pure deletion', () => {
    expect(parseUnifiedDiff(unifiedDiff('x', 'a', 'a\nb')!)[0].added).toBe(1);
    expect(parseUnifiedDiff(unifiedDiff('x', 'a\nb', 'a')!)[0].deleted).toBe(1);
  });
});
