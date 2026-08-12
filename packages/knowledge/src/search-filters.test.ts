/**
 * The search filters must be applied as SQL predicates, not as a post-fetch
 * JS filter: the query returns only `overfetch` (≈2k) rows ordered by vector
 * distance, so anything discarded afterwards comes straight out of an
 * already-small candidate set. A filter that "works" in JS would silently
 * return near-empty result sets on a large corpus — the exact
 * looks-fine-but-is-wrong failure this suite exists to prevent.
 */

/** Captures the interpolated fragments of the tagged template the search builds. */
let lastQuery: { strings: readonly string[]; values: unknown[] } | null = null;
let rows: Record<string, unknown>[] = [];

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: true, val: {} }),
}));

jest.mock('kysely', () => {
  const sql = (strings: readonly string[], ...values: unknown[]) => {
    const node = {
      strings,
      values,
      execute: async () => {
        lastQuery = { strings, values };
        return { rows };
      },
    };
    return node;
  };
  return { sql };
});

jest.mock('@renkei/gates', () => ({
  // Pass every candidate through: the gate has its own tests, and mixing it
  // in here would confuse "filtered by SQL" with "denied by the gate".
  verifyCandidates: async (_verifiers: unknown, _userId: string, candidates: unknown[]) => ({
    allowed: candidates,
    elided: 0,
  }),
}));

import { searchKnowledge } from './index';

/** The whole SQL text, with interpolations rendered as readable placeholders. */
function renderedSql(): string {
  if (!lastQuery) return '';
  return lastQuery.strings
    .map((part, index) => {
      if (index >= lastQuery!.values.length) return part;
      const value = lastQuery!.values[index];
      // Nested sql`` fragments interpolate as objects carrying their own strings.
      const nested = isFragment(value) ? value.strings.join('?') : `«${String(value)}»`;
      return part + nested;
    })
    .join('');
}

/**
 * A nested sql`` fragment, not a plain value. Both `strings` and `values`
 * are required, and arrays are excluded first: `'values' in []` is TRUE
 * because of `Array.prototype.values`, so a bare `in` check treats every
 * string[] filter argument as a fragment and recurses into a function.
 */
function isFragment(value: unknown): value is { strings: readonly string[]; values: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'strings' in value &&
    'values' in value
  );
}

/** Every interpolated value, including those inside nested sql`` fragments. */
function allValues(): unknown[] {
  const collected: unknown[] = [];
  const walk = (values: readonly unknown[]) => {
    for (const value of values) {
      if (isFragment(value)) walk(value.values);
      else collected.push(value);
    }
  };
  walk(lastQuery?.values ?? []);
  return collected;
}

const embedder = { embed: async () => ({ ok: true as const, val: [[0.1, 0.2]] }) };

const baseOptions = {
  tenantId: 'tenant-1',
  userEmail: 'scott@example.com',
  query: 'anything',
  k: 5,
  embedder,
  verifiers: new Map(),
};

beforeEach(() => {
  lastQuery = null;
  rows = [];
});

describe('searchKnowledge filter construction', () => {
  it('filters nothing when no filters are given', async () => {
    await searchKnowledge({ ...baseOptions });
    const sqlText = renderedSql();
    expect(sqlText).toContain('tenant_id =');
    // The no-filter path must stay identical to the original plan.
    expect(sqlText).not.toContain('provider = ANY');
    expect(sqlText).not.toContain("metadata ->> 'kind'");
    // source_at is always SELECTed; what must be absent is the PREDICATE.
    expect(sqlText).not.toContain('source_at IS NOT NULL');
  });

  it('puts the provider filter in SQL, not in JS', async () => {
    await searchKnowledge({ ...baseOptions, providers: ['microsoft', 'confluence'] });
    expect(renderedSql()).toContain('provider = ANY');
    expect(allValues()).toContainEqual(['microsoft', 'confluence']);
  });

  it('puts the kind filter in SQL', async () => {
    await searchKnowledge({ ...baseOptions, kinds: ['msg'] });
    expect(renderedSql()).toContain("metadata ->> 'kind' = ANY");
  });

  it('puts date bounds in SQL and excludes undated rows', async () => {
    await searchKnowledge({
      ...baseOptions,
      after: '2026-01-01T00:00:00Z',
      before: '2026-02-01T00:00:00Z',
    });
    const sqlText = renderedSql();
    // NULL source_at must not satisfy a dated query — otherwise "mail from
    // last week" sweeps in everything a connector never dated.
    expect(sqlText).toContain('source_at IS NOT NULL');
    expect(sqlText).toContain('source_at >=');
    expect(sqlText).toContain('source_at <');
  });

  it('treats blank/whitespace filter entries as "no filter", not "match nothing"', async () => {
    await searchKnowledge({ ...baseOptions, providers: ['  ', ''], kinds: [''] });
    const sqlText = renderedSql();
    expect(sqlText).not.toContain('provider = ANY');
    expect(sqlText).not.toContain("metadata ->> 'kind'");
  });

  it('ignores an unparseable date rather than matching nothing', async () => {
    await searchKnowledge({ ...baseOptions, after: 'not-a-date' });
    expect(renderedSql()).not.toContain('source_at IS NOT NULL');
  });
});

describe('searchKnowledge result shape', () => {
  it('surfaces source_at as an ISO string', async () => {
    rows = [
      {
        provider: 'microsoft',
        ref_id: 'a@b.com/msg/1',
        content: 'hello',
        metadata: { kind: 'msg' },
        distance: 0.12,
        source_at: new Date('2026-08-01T10:00:00Z'),
      },
    ];
    const result = await searchKnowledge({ ...baseOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.hits[0]?.sourceAt).toBe('2026-08-01T10:00:00.000Z');
  });

  it('reports a null source_at as null rather than an epoch date', async () => {
    rows = [
      {
        provider: 'webex',
        ref_id: 'room/msg',
        content: 'hello',
        metadata: {},
        distance: 0.2,
        source_at: null,
      },
    ];
    const result = await searchKnowledge({ ...baseOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.hits[0]?.sourceAt).toBeNull();
  });
});
