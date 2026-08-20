/**
 * The attachment-payload and timeout hygiene helpers: base64 must decode
 * strictly (Buffer.from alone silently corrupts bad input), data: URL
 * prefixes are stripped as the schemas promise, and a caller-supplied abort
 * signal always beats the default deadline.
 */

import {
  REQUEST_TIMEOUT_MS,
  base64LengthFor,
  decodeBase64Attachment,
  isTimeoutError,
  timeoutSignal,
} from './fetch-guard';

describe('decodeBase64Attachment', () => {
  const payload = Buffer.from('hello world').toString('base64');

  it('decodes bare base64', () => {
    const result = decodeBase64Attachment(payload);
    if (!result.ok) throw new Error(result.error);
    expect(result.buffer.toString('utf8')).toBe('hello world');
  });

  it('strips a data:*;base64, URL prefix', () => {
    const result = decodeBase64Attachment(`data:image/png;base64,${payload}`);
    if (!result.ok) throw new Error(result.error);
    expect(result.buffer.toString('utf8')).toBe('hello world');
  });

  it('rejects a data: URL that is not base64-encoded', () => {
    const result = decodeBase64Attachment('data:text/plain,hello%20world');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not base64-encoded');
  });

  it('rejects non-base64 characters instead of silently corrupting', () => {
    const result = decodeBase64Attachment('not@base64!content');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid base64');
  });

  it('rejects truncated payloads (length not a multiple of 4)', () => {
    expect(decodeBase64Attachment(payload.slice(0, -1)).ok).toBe(false);
  });

  it('tolerates embedded newlines and spaces (models wrap base64)', () => {
    const wrapped = payload.replace(/(.{8})/g, '$1\n');
    const result = decodeBase64Attachment(wrapped);
    if (!result.ok) throw new Error(result.error);
    expect(result.buffer.toString('utf8')).toBe('hello world');
  });

  it('rejects empty input', () => {
    expect(decodeBase64Attachment('   ').ok).toBe(false);
  });
});

describe('base64LengthFor', () => {
  it('covers the 4/3 inflation plus prefix headroom', () => {
    const maxBytes = 20_971_520;
    const budget = base64LengthFor(maxBytes);
    // A maximal payload with a data: prefix must fit under the budget.
    expect(budget).toBeGreaterThanOrEqual(Math.ceil(maxBytes / 3) * 4);
    expect(budget - Math.ceil(maxBytes / 3) * 4).toBeGreaterThanOrEqual(24);
  });
});

describe('timeoutSignal', () => {
  it('prefers a caller-supplied signal', () => {
    const controller = new AbortController();
    expect(timeoutSignal({ signal: controller.signal }, REQUEST_TIMEOUT_MS)).toBe(
      controller.signal
    );
  });

  it('provides a deadline signal otherwise', () => {
    expect(timeoutSignal(undefined, REQUEST_TIMEOUT_MS)).toBeInstanceOf(AbortSignal);
  });
});

describe('isTimeoutError', () => {
  it('classifies only TimeoutError', () => {
    expect(isTimeoutError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('a'), { name: 'AbortError' }))).toBe(false);
    expect(isTimeoutError(new TypeError('fetch failed'))).toBe(false);
  });
});
