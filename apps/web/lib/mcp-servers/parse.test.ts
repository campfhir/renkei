import { parseServerPayload, slugFor } from './parse';

describe('parseServerPayload', () => {
  const valid = { name: 'Acme Docs', url: 'https://mcp.acme.test/mcp' };

  it('accepts a minimal server and defaults to OAuth over streamable HTTP', () => {
    const parsed = parseServerPayload(valid);
    expect('input' in parsed && parsed.input).toMatchObject({
      transport: 'streamable_http',
      authMode: 'oauth',
      enabled: true,
      context: '',
    });
  });

  it('derives the tool prefix from the name unless one is typed', () => {
    const parsed = parseServerPayload(valid);
    if (!('input' in parsed)) throw new Error('expected input');
    expect(slugFor(parsed.input)).toBe('acme_docs');
    const typed = parseServerPayload({ ...valid, slug: 'docs' });
    if (!('input' in typed)) throw new Error('expected input');
    expect(slugFor(typed.input)).toBe('docs');
  });

  it('refuses what cannot work', () => {
    expect('error' in parseServerPayload({ ...valid, name: '' })).toBe(true);
    expect('error' in parseServerPayload({ ...valid, url: 'http://mcp.acme.test' })).toBe(true);
    expect('error' in parseServerPayload({ ...valid, transport: 'websocket' })).toBe(true);
    expect('error' in parseServerPayload({ ...valid, slug: 'Bad Slug' })).toBe(true);
    expect('error' in parseServerPayload({ ...valid, context: 'x'.repeat(4001) })).toBe(true);
    expect('error' in parseServerPayload('nope')).toBe(true);
  });

  it('carries the admin context and the legacy transport through', () => {
    const parsed = parseServerPayload({
      ...valid,
      transport: 'sse',
      context: ' Claims and policies ',
    });
    expect('input' in parsed && parsed.input).toMatchObject({
      transport: 'sse',
      context: 'Claims and policies',
    });
  });
});
