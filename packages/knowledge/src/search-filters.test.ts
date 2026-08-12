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
  // Real kysely's sql.join, modelled as a fragment whose values alternate
  // between the pieces and the separator — enough for the renderer and the
  // value walker below to see straight through it.
  sql.join = (fragments: unknown[], separator: unknown) => {
    const values: unknown[] = [];
    fragments.forEach((fragment, index) => {
      if (index > 0) values.push(separator);
      values.push(fragment);
    });
    return { strings: new Array(values.length + 1).fill(''), values };
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

import { searchKnowledge, listRecentKnowledge } from './index';

/**
 * The whole SQL text, with interpolations rendered as readable placeholders.
 * Recursive, because fragments now nest more than one level deep: a source
 * filter is a joined list of per-source fragments.
 */
function renderFragment(fragment: { strings: readonly string[]; values: unknown[] }): string {
  return fragment.strings
    .map((part, index) => {
      if (index >= fragment.values.length) return part;
      const value = fragment.values[index];
      return part + (isFragment(value) ? renderFragment(value) : `«${String(value)}»`);
    })
    .join('');
}

function renderedSql(): string {
  return lastQuery ? renderFragment(lastQuery) : '';
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
    expect(sqlText).not.toContain('provider =');
    expect(sqlText).not.toContain("metadata ->> 'kind'");
    // source_at is always SELECTed; what must be absent is the PREDICATE.
    expect(sqlText).not.toContain('source_at IS NOT NULL');
  });

  it('puts the source filter in SQL, not in JS', async () => {
    await searchKnowledge({
      ...baseOptions,
      sources: [{ provider: 'microsoft' }, { provider: 'confluence' }],
    });
    expect(renderedSql()).toContain('provider =');
    expect(allValues()).toContain('microsoft');
    expect(allValues()).toContain('confluence');
  });

  it('pins the kind alongside its own provider, not across the whole query', async () => {
    await searchKnowledge({
      ...baseOptions,
      sources: [{ provider: 'microsoft', kind: 'msg' }, { provider: 'jira' }],
    });
    const sqlText = renderedSql();
    // The pair is AND-ed inside its own group and OR-ed with the other, so
    // Jira is not silently required to carry kind 'msg' — and microsoft is
    // not silently widened to calendar and tasks to save it.
    expect(sqlText).toContain("metadata ->> 'kind'");
    expect(sqlText).toContain(' OR ');
    expect(allValues()).toContain('msg');
    expect(allValues()).toContain('jira');
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
    await searchKnowledge({ ...baseOptions, sources: [{ provider: '  ' }, { provider: '' }] });
    const sqlText = renderedSql();
    expect(sqlText).not.toContain('provider =');
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

describe('listRecentKnowledge', () => {
  const recentOptions = {
    tenantId: 'tenant-1',
    userEmail: 'scott@example.com',
    k: 5,
    verifiers: new Map(),
  };

  it('orders by recency and never embeds anything', async () => {
    // A blank query has no meaningful embedding; ordering by its distance
    // would return an arbitrary slice while looking authoritative.
    await listRecentKnowledge({ ...recentOptions });
    const sqlText = renderedSql();
    expect(sqlText).toContain('ORDER BY source_at DESC');
    expect(sqlText).not.toContain('embedding <=>');
  });

  it('excludes undated rows, which have no place in a recency list', async () => {
    await listRecentKnowledge({ ...recentOptions });
    expect(renderedSql()).toContain('source_at IS NOT NULL');
  });

  it('applies the same source filters search does', async () => {
    await listRecentKnowledge({ ...recentOptions, sources: [{ provider: 'confluence' }] });
    expect(renderedSql()).toContain('provider =');
    expect(allValues()).toContain('confluence');
  });

  it('still runs every candidate through the ACL gate', async () => {
    rows = [
      {
        provider: 'microsoft',
        ref_id: 'a@b.com/msg/1',
        content: 'hello',
        metadata: { subject: 'Hi' },
        distance: 0,
        source_at: new Date('2026-08-01T10:00:00Z'),
      },
    ];
    const result = await listRecentKnowledge({ ...recentOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The mocked gate allows everything; what matters is that the shape
    // carries the gate's elided count rather than bypassing it.
    expect(result.val).toHaveProperty('elided');
    expect(result.val.hits[0]?.sourceAt).toBe('2026-08-01T10:00:00.000Z');
  });
});
