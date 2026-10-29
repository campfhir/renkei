/**
 * The SQL half of knowledge search's `key:value` filters: what the store's
 * Postgres side compiles a filter to. Nothing a user types reaches the SQL
 * as anything but a parameter, and a negated filter still matches rows
 * missing the key. (Which words become filters is @renkei/knowledge's
 * splitQuery, tested there.)
 */

import { Kysely, PostgresDialect } from 'kysely';
import { compileMetadataFilter, type MetadataFilterExpr } from './metadata-filter';

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

  it('binds every value of an or as a parameter', () => {
    const built = compiled({ type: 'or', nodes: [filter('space', 'Eng'), filter('space', 'Ops')] });
    expect(built!.sql).toContain(' OR ');
    expect(built!.parameters).toEqual(expect.arrayContaining(['space', '%Eng%', '%Ops%']));
  });
});
