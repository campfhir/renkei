/**
 * The record-number pattern language.
 *
 * The security property is the reason this exists: every compiled pattern is a
 * flat sequence of single-character classes with bounded repetition, so there
 * is nothing for the regex engine to backtrack over. The final test measures
 * that rather than asserting it, because "should be fast" is the kind of claim
 * that quietly stops being true.
 */

import { compileFormat, describeFormatProblem, formatIsGeneric } from './format';

const matches = (format: string, text: string): boolean => {
  const compiled = compileFormat(format);
  if (!compiled) throw new Error(`did not compile: ${format}`);
  compiled.regex.lastIndex = 0;
  return compiled.regex.test(text);
};

describe('compileFormat', () => {
  it('matches the shapes real record numbers take', () => {
    expect(matches('MR-#######', 'chart MR-4417732 filed')).toBe(true);
    expect(matches('@#######', 'ref X4417732 here')).toBe(true);
    expect(matches('##-####-##', 'id 44-1773-21')).toBe(true);
    expect(matches('*{8}', 'token A1B2C3D4 issued')).toBe(true);
  });

  it('honours repetition counts exactly', () => {
    expect(matches('MR-#{7}', 'MR-4417732')).toBe(true);
    expect(matches('MR-#{7}', 'MR-441773')).toBe(false);
    expect(matches('@#{6,8}', 'X441773')).toBe(true);
    expect(matches('@#{6,8}', 'X44177322')).toBe(true);
    expect(matches('@#{6,8}', 'X4417')).toBe(false);
  });

  it('does not fire inside a longer token', () => {
    expect(matches('MR-#{4}', 'MR-1234')).toBe(true);
    expect(matches('MR-#{4}', 'XMR-12345678')).toBe(false);
  });

  it('does not match a fragment of a hyphenated token', () => {
    // The one that mattered: a word boundary sits between a digit and a
    // hyphen, so `####-##` matched `2026-08` inside `2026-08-13` and a
    // generic format would have redacted every ISO date in every result.
    expect(matches('####-##', '2026-08-13')).toBe(false);
    expect(matches('####-##', 'Sprint 2026-08-01 to 2026-08-14')).toBe(false);
    // Still matches when it IS the whole token.
    expect(matches('####-##', 'MRN 1234-05 admitted')).toBe(true);
    expect(matches('####-##', 'chart 1234-05.')).toBe(true);
  });

  it('treats regex syntax as ordinary text, not as syntax', () => {
    // Someone pasting a regular expression gets a pattern matching that
    // literal text — useless, but harmless, which is the point.
    const compiled = compileFormat('(a+)+$#');
    expect(compiled).not.toBeNull();
    expect(compiled?.regex.source).toContain('\\(');
    expect(compiled?.regex.source).not.toContain('(a+)+');
  });

  it('refuses patterns that would match ordinary words', () => {
    // All-literal would redact every mention of "PATIENT" in every result.
    // This is also why the letter placeholder is @ and not A: with A, the one
    // inside PATIENT made it a wildcard and the pattern was accepted.
    expect(compileFormat('PATIENT')).toBeNull();
    expect(compileFormat('MRN')).toBeNull();
    expect(describeFormatProblem('PATIENT')).toContain('at least one');
  });

  it('refuses unbounded or oversized repetition', () => {
    expect(compileFormat('#{0}')).toBeNull();
    expect(compileFormat('#{99}')).toBeNull();
    expect(compileFormat('#{5,2}')).toBeNull();
    expect(compileFormat('#{')).toBeNull();
    expect(compileFormat('{4}')).toBeNull();
    expect(compileFormat('#'.repeat(200))).toBeNull();
  });

  it('reports why a pattern was rejected', () => {
    expect(describeFormatProblem('MR-#######')).toBeNull();
    expect(describeFormatProblem('')).toBe('Empty pattern');
    expect(describeFormatProblem('#{99}')).toContain('valid pattern');
  });

  it('cannot be made to backtrack catastrophically', () => {
    // The measurement that matters. As a raw regex, `(a+)+$` against this
    // input takes over a minute of blocked event loop; as a pattern in this
    // language it is literal text and returns immediately.
    const compiled = compileFormat('(a+)+$#');
    const hostile = `${'a'.repeat(5000)}b`;
    const started = Date.now();
    compiled?.regex.test(hostile);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('stays fast on a large input with a maximal pattern', () => {
    const compiled = compileFormat('@*{40}#{40}');
    const haystack = `${'x9'.repeat(50_000)} MR-4417732`;
    const started = Date.now();
    compiled?.regex.test(haystack);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('formatIsGeneric', () => {
  it('flags a shape with no fixed text of its own', () => {
    // `####-##` is also an invoice number and a year-month.
    expect(formatIsGeneric('####-##')).toBe(true);
    expect(formatIsGeneric('#{8}')).toBe(true);
    expect(formatIsGeneric('*{6}')).toBe(true);
  });

  it('does not flag one anchored by a literal prefix', () => {
    expect(formatIsGeneric('MR-#######')).toBe(false);
    expect(formatIsGeneric('XY-####-##')).toBe(false);
  });
});
