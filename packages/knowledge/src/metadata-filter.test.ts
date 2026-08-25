/**
 * The `key:value` half of knowledge search. What matters: bare words go to
 * the vector and filters go to SQL, a negated filter still matches rows
 * missing the key, and nothing a user types can reach the SQL as anything
 * but a parameter.
 */

import { Kysely, PostgresDialect } from 'kysely';
import { compileMetadataFilter, splitQuery, type MetadataFilterExpr } from './metadata-filter';

/**
 * A Kysely that can COMPILE but never connects: turning a fragment into SQL
 * is a pure operation, and the pool is never touched by it.
 */
/* eslint-disable-next-line @typescript-eslint/consistent-type-assertions --
   The dialect wants a pg Pool it will never reach: compiling a fragment to
   SQL is a pure operation and opens no connection. */
const neverConnected = {} as never;
const compiler = new Kysely<Record<string, never>>({
  dialect: new PostgresDialect({ pool: neverConnected }),
});

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

describe('compileMetadataFilter', () => {
  const compiled = (expr: MetadataFilterExpr | null) => {
    const built = compileMetadataFilter(expr);
    return built ? built.compile(compiler) : null;
  };

  it('is null when there is nothing to narrow, so the plan is unchanged', () => {
    expect(compileMetadataFilter(null)).toBeNull();
    expect(compileMetadataFilter(bare('printers'))).toBeNull();
    expect(compileMetadataFilter({ type: 'and', nodes: [] })).toBeNull();
  });

  it('parameterises the key and the value — never interpolates them', () => {
    const built = compiled(filter('reporter', "Robert'); DROP TABLE knowledge_chunks;--"));
    expect(built).not.toBeNull();
    // Both sides arrive as bound parameters; the SQL text carries neither.
    expect(built!.sql).not.toContain('DROP TABLE');
    expect(built!.sql).not.toContain('reporter');
    expect(built!.parameters).toContain('reporter');
  });

  it('matches a negated filter against rows that lack the key at all', () => {
    const built = compiled(filter('from', 'evan', { negated: true }));
    // "not from Evan" is true of a document with no sender; SQL NULL would
    // otherwise quietly exclude it.
    expect(built!.sql).toContain('IS NULL');
  });

  it('joins and/or as written', () => {
    const built = compiled({
      type: 'and',
      nodes: [filter('space', 'Eng'), { type: 'or', nodes: [filter('a', '1'), filter('b', '2')] }],
    });
    expect(built!.sql).toContain(' AND ');
    expect(built!.sql).toContain(' OR ');
  });
});
