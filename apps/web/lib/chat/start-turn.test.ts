import { splitPaste } from './start-turn';

describe('splitPaste', () => {
  it('returns the text whole when it fits in one chunk', () => {
    expect(splitPaste('hello', 100)).toEqual(['hello']);
    expect(splitPaste('', 100)).toEqual(['']);
  });

  it('always concatenates back to the original text exactly', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`.repeat(3)).join('\n');
    const chunks = splitPaste(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers breaking on a newline near the boundary', () => {
    const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}\n${'c'.repeat(50)}`;
    const chunks = splitPaste(text, 60);
    // The break lands on the newline rather than mid-run of a's or b's.
    expect(chunks[0]).toBe(`${'a'.repeat(50)}\n`);
    expect(chunks.join('')).toBe(text);
  });

  it('hard-cuts when there is no newline near the boundary (one giant unbroken line)', () => {
    const text = 'x'.repeat(1000);
    const chunks = splitPaste(text, 100);
    expect(chunks).toHaveLength(10);
    expect(chunks.every((chunk) => chunk.length === 100)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});
