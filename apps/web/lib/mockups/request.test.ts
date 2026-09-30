/**
 * A mockup request's promises: a call the model can make is parsed once,
 * the same way by the tool, the route and the thread; what is missing or
 * out of bounds is refused in words the model can act on; sizes are
 * clamped, not refused.
 */

import { parseMockupRequest } from './request';

const ok = { title: 'Settings', format: 'react', source: 'export default () => null;' };

describe('parseMockupRequest', () => {
  it('takes a minimal request, with the defaults filled in', () => {
    expect(parseMockupRequest(ok)).toEqual({
      ok: true,
      request: {
        title: 'Settings',
        format: 'react',
        source: 'export default () => null;',
        css: '',
        width: 1024,
        height: null,
      },
    });
  });

  it('names an untitled mockup rather than refusing it', () => {
    const parsed = parseMockupRequest({ ...ok, title: '   ' });
    expect(parsed.ok && parsed.request.title).toBe('Mockup');
  });

  it('clamps width and height into their range', () => {
    const parsed = parseMockupRequest({ ...ok, width: 50, height: 99_999 });
    expect(parsed.ok && [parsed.request.width, parsed.request.height]).toEqual([240, 4000]);
  });

  it.each([
    ['a format that does not exist', { ...ok, format: 'vue' }, /format must be/],
    ['no source', { ...ok, source: '  ' }, /source is required/],
    ['a huge source', { ...ok, source: 'x'.repeat(80_001) }, /most a mockup may be/],
    ['css that is not text', { ...ok, css: 3 }, /css must be text/],
    ['an svg that is not an svg', { ...ok, format: 'svg', source: '<div/>' }, /<svg>/],
    ['a width that is not a number', { ...ok, width: '800' }, /numbers of pixels/],
  ])('refuses %s', (_name, input, message) => {
    const parsed = parseMockupRequest(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toMatch(message);
  });

  it('refuses what is not an object', () => {
    expect(parseMockupRequest(null).ok).toBe(false);
    expect(parseMockupRequest([]).ok).toBe(false);
    expect(parseMockupRequest('<div/>').ok).toBe(false);
  });
});
