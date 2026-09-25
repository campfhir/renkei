/**
 * Confluence error bodies become one actionable sentence: the v2 and v1
 * envelopes are both read, a 413 explains Confluence Cloud's own payload
 * ceiling, and junk (HTML, empty) degrades to the bare status.
 */

import { confluenceErrorDetail, describeConfluenceError } from './errors';

describe('confluenceErrorDetail', () => {
  it('reads the v2 errors envelope', () => {
    const body = JSON.stringify({
      errors: [{ status: 400, code: 'INVALID_REQUEST_PARAMETER', title: 'Title already exists' }],
    });
    expect(confluenceErrorDetail(body)).toBe('Title already exists');
  });

  it('joins title and detail, and several errors', () => {
    const body = JSON.stringify({
      errors: [{ title: 'Bad body', detail: 'ADF node "foo" is unknown' }, { title: 'Bad parent' }],
    });
    expect(confluenceErrorDetail(body)).toBe('Bad body: ADF node "foo" is unknown; Bad parent');
  });

  it('reads the v1 message envelope', () => {
    expect(confluenceErrorDetail(JSON.stringify({ statusCode: 400, message: 'No space' }))).toBe(
      'No space'
    );
  });

  it('quotes short plain text but never an HTML error page', () => {
    expect(confluenceErrorDetail('Request Entity Too Large')).toBe('Request Entity Too Large');
    expect(confluenceErrorDetail('<html><body>413</body></html>')).toBe('');
    expect(confluenceErrorDetail('')).toBe('');
  });

  it('caps a long message', () => {
    const detail = confluenceErrorDetail(JSON.stringify({ message: 'x'.repeat(1000) }));
    expect(detail.length).toBeLessThan(320);
    expect(detail.endsWith('…')).toBe(true);
  });
});

describe('describeConfluenceError', () => {
  it('surfaces the API reason next to the status', () => {
    const body = JSON.stringify({ errors: [{ title: 'Title already exists' }] });
    expect(describeConfluenceError(400, body)).toBe(
      'Confluence API answered 400: Title already exists'
    );
  });

  it('falls back to the bare status without a reason', () => {
    expect(describeConfluenceError(500, '')).toBe('Confluence API answered 500');
  });

  it('explains a 413 as Confluence Cloud’s own payload ceiling', () => {
    const text = describeConfluenceError(413, '');
    expect(text).toContain('413');
    expect(text).toContain('5 MB');
    expect(text).toContain('child pages');
  });

  it('keeps the scope and rate-limit sentences', () => {
    expect(describeConfluenceError(403, '')).toContain('scope');
    expect(describeConfluenceError(429, '')).toContain('rate limiting');
  });
});
