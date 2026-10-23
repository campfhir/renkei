/**
 * The library's URL: what the page reads from it, with every malformed
 * value falling back, and what the client writes to it, with every
 * default left out.
 */

import { libraryQueryString, parseLibraryQuery, queryTermsOf } from './artifact-library-params';

const ID = '0f4a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

describe('parseLibraryQuery', () => {
  it('reads every parameter', () => {
    expect(
      parseLibraryQuery(
        new URLSearchParams({
          q: ' rounding ',
          show: 'shared',
          project: ID,
          page: '3',
          artifact: ID,
        })
      )
    ).toEqual({ show: 'shared', projectId: ID, query: 'rounding', page: 3, focus: ID });
  });

  it('falls back on anything malformed, and takes the first of a repeated one', () => {
    expect(
      parseLibraryQuery({
        show: 'mine',
        project: 'not-a-uuid',
        page: '0',
        artifact: 'x',
        q: undefined,
      })
    ).toEqual({ show: 'all', projectId: null, query: '', page: 1, focus: null });
    expect(parseLibraryQuery({ page: ['2', '9'], show: ['generated'] })).toMatchObject({
      page: 2,
      show: 'generated',
    });
    expect(parseLibraryQuery({ page: '2.5' }).page).toBe(1);
    expect(parseLibraryQuery({ q: 'x'.repeat(500) }).query).toHaveLength(200);
  });
});

describe('libraryQueryString', () => {
  it('writes only what differs from the default', () => {
    expect(libraryQueryString({ show: 'all', projectId: null, query: '' }, 1)).toBe('');
    expect(libraryQueryString({ show: 'uploaded', projectId: ID, query: 'a b' }, 2, ID)).toBe(
      `?q=a+b&show=uploaded&project=${ID}&page=2&artifact=${ID}`
    );
  });
});

describe('queryTermsOf', () => {
  it('splits on whitespace, lowercases and bounds the count', () => {
    expect(queryTermsOf('  Invoice   Rounding ')).toEqual(['invoice', 'rounding']);
    expect(queryTermsOf('a b c d e f g h i j')).toHaveLength(8);
    expect(queryTermsOf('')).toEqual([]);
  });
});
