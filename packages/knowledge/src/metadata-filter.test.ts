/**
 * The `key:value` half of knowledge search. What matters: bare words go to
 * the vector and filters go to SQL, with their grouping kept. (What a
 * filter compiles to is the store's: packages/db's metadata-filter test.)
 */

import { splitQuery, type MetadataFilterExpr } from './metadata-filter';

const filter = (
  key: string,
  value: string,
  extra: Partial<{ operator: 'contains' | '='; negated: boolean }> = {}
): MetadataFilterExpr => ({
  type: 'filter',
  filter: { key, value, operator: extra.operator ?? 'contains', ...extra },
});

/** The parsed shape bored-logs actually emits for a bare word. */
const bare = (value: string): MetadataFilterExpr => filter('$message', value);

describe('splitQuery', () => {
  it('sends bare words to the vector and keeps the rest as filters', () => {
    const { terms, filter: kept } = splitQuery({
      type: 'and',
      nodes: [bare('printers'), bare('broken'), filter('ticket', 'ENG-787')],
    });
    expect(terms).toEqual(['printers', 'broken']);
    expect(kept).toEqual(filter('ticket', 'ENG-787'));
  });

  it('leaves nothing to embed when the query is only filters', () => {
    const { terms, filter: kept } = splitQuery({
      type: 'and',
      nodes: [filter('reporter', 'Evan'), filter('space', 'Engineering')],
    });
    expect(terms).toEqual([]);
    // Both survive — the caller browses newest-matching rather than
    // embedding an empty string.
    expect(kept?.type).toBe('and');
  });

  it('drops a negated bare word — a vector has no "unlike this" direction', () => {
    const { terms, filter: kept } = splitQuery({
      type: 'and',
      nodes: [
        {
          type: 'filter',
          filter: { key: '$message', value: 'x', operator: 'contains', negated: true },
        },
      ],
    });
    expect(terms).toEqual([]);
    expect(kept).toBeNull();
  });
});

describe('|| across the two halves', () => {
  it('supports || between filters, which is the common case', () => {
    const { filter: kept, unsupported } = splitQuery({
      type: 'or',
      nodes: [filter('space', 'Eng'), filter('space', 'Ops')],
    });
    expect(unsupported).toBeNull();
    expect(kept).toEqual({
      type: 'or',
      nodes: [filter('space', 'Eng'), filter('space', 'Ops')],
    });
  });

  it('keeps grouping: (a || b) && c', () => {
    const { filter: kept } = splitQuery({
      type: 'and',
      nodes: [
        { type: 'or', nodes: [filter('space', 'Eng'), filter('space', 'Ops')] },
        filter('ticket', 'ENG-787'),
      ],
    });
    expect(kept).toEqual({
      type: 'and',
      nodes: [
        { type: 'or', nodes: [filter('space', 'Eng'), filter('space', 'Ops')] },
        filter('ticket', 'ENG-787'),
      ],
    });
  });

  it('refuses a word OR-ed with a filter instead of quietly ANDing it', () => {
    // The halves recombine as AND by construction, so this cannot be
    // honoured — and answering a narrower question without saying so is the
    // worst of the options.
    const {
      unsupported,
      filter: kept,
      terms,
    } = splitQuery({
      type: 'or',
      nodes: [bare('printers'), filter('ticket', 'ENG-787')],
    });
    expect(unsupported).toContain('cannot be combined with ||');
    expect(kept).toBeNull();
    expect(terms).toEqual([]);
  });

  it('still allows a word AND-ed with an OR of filters', () => {
    const {
      terms,
      filter: kept,
      unsupported,
    } = splitQuery({
      type: 'and',
      nodes: [bare('printers'), { type: 'or', nodes: [filter('a', '1'), filter('b', '2')] }],
    });
    expect(unsupported).toBeNull();
    expect(terms).toEqual(['printers']);
    expect(kept?.type).toBe('or');
  });
});
