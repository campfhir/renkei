import { validateFilename } from './naming';

describe('validateFilename', () => {
  it('accepts a plain filename', () => {
    const result = validateFilename('invoice.pdf');
    expect(result).toEqual({ ok: true, filename: 'invoice.pdf' });
  });

  it('trims surrounding whitespace', () => {
    const result = validateFilename('  invoice.pdf  ');
    expect(result).toEqual({ ok: true, filename: 'invoice.pdf' });
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(validateFilename('')).toEqual({ ok: false });
    expect(validateFilename('   ')).toEqual({ ok: false });
  });

  it('rejects path separators and traversal', () => {
    for (const bad of ['a/b.pdf', 'a\\b.pdf', '..', '.', '../escape.pdf']) {
      expect(validateFilename(bad)).toEqual({ ok: false });
    }
  });

  it('rejects a null byte', () => {
    expect(validateFilename('a\0b.pdf')).toEqual({ ok: false });
  });

  it('rejects a name over the length ceiling', () => {
    expect(validateFilename('a'.repeat(256))).toEqual({ ok: false });
  });
});
