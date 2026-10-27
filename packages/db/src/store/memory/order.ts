/**
 * Postgres's comparison and matching rules, in JavaScript, for the memory
 * store's repositories to sort and filter with. Strings compare under ICU
 * en-US — the collation the contract database is created with
 * (differential/harness.ts) and the one V8's Intl uses — so an ORDER BY
 * name comes out the same on both sides.
 */

const collator = new Intl.Collator('en-US');

/**
 * ORDER BY … ASC for one value: nulls last, strings by collation, Dates by
 * instant, booleans false first. int8 and numeric columns arrive as
 * strings, as pg returns them: convert them with Number() in the key
 * function before comparing, as Postgres compares them numerically.
 */
export function compareAsc(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b);
  return collator.compare(String(a), String(b));
}

/** One ORDER BY term: a key, and DESC (which in Postgres also puts nulls first). */
export type OrderTerm<T> = [key: (row: T) => unknown, direction?: 'asc' | 'desc'];

/** A sorted copy, by the terms in order — ORDER BY a, b DESC, … */
export function orderBy<T>(rows: readonly T[], ...terms: OrderTerm<T>[]): T[] {
  return [...rows].sort((x, y) => {
    for (const [key, direction = 'asc'] of terms) {
      const result = compareAsc(key(x), key(y));
      if (result !== 0) return direction === 'asc' ? result : -result;
    }
    return 0;
  });
}

/** `value ILIKE pattern` (or LIKE, `caseSensitive`), with % and _ and backslash escapes. */
export function like(
  value: string | null | undefined,
  pattern: string,
  caseSensitive = false
): boolean {
  if (value === null || value === undefined) return false;
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\' && i + 1 < pattern.length) {
      i += 1;
      source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '%') source += '[\\s\\S]*';
    else if (char === '_') source += '[\\s\\S]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseSensitive ? 'u' : 'iu').test(value);
}

/** LIMIT / OFFSET. */
export function page<T>(rows: readonly T[], limit?: number, offset = 0): T[] {
  return rows.slice(offset, limit === undefined ? undefined : offset + limit);
}

/** Postgres equality for a key: Dates by instant, everything else strictly. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** count(DISTINCT …)-style grouping: rows keyed by `key`, in first-seen order. */
export function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}
