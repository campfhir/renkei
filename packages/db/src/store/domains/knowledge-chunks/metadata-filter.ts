/**
 * `key:value` filters over a knowledge chunk's metadata — compiled to SQL
 * for Postgres, and evaluated in JavaScript for the memory store.
 *
 * The syntax and its parser are bored-logs' — the same thing the activity log
 * search speaks, so anyone who has filtered logs here already knows how to
 * filter knowledge. Only the COMPILATION is ours: logs match against their
 * attributes table, and these match against `knowledge_chunks.metadata`.
 * (@renkei/knowledge re-exports this alongside `splitQuery`; it lives here
 * because the store's Postgres side is what runs it.)
 *
 * The tree type is declared structurally rather than imported, so the
 * knowledge layer does not take a dependency on a logging library for the
 * sake of a three-member union. The web app parses; this compiles.
 *
 * A bare word is NOT handled here. The parser turns bare words into
 * `$message` leaves, and the caller lifts those out to use as the semantic
 * query — searching the vector is what a bare word means, and no amount of
 * SQL over metadata would do that job.
 */

import { sql, type RawBuilder } from 'kysely';
import { compareAsc, like } from '../../memory/order';

export type MetadataFilterOperator = 'contains' | '=' | '>' | '>=' | '<' | '<=';

export interface MetadataFilterToken {
  key: string;
  operator: MetadataFilterOperator;
  value: string;
  negated?: boolean;
}

export type MetadataFilterExpr =
  | { type: 'and'; nodes: MetadataFilterExpr[] }
  | { type: 'or'; nodes: MetadataFilterExpr[] }
  | { type: 'filter'; filter: MetadataFilterToken };

/** The key bored-logs gives a bare, un-keyed word. */
export const FREE_TEXT_KEY = '$message';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * One comparison against `metadata`.
 *
 * Values are compared as TEXT via `->>`, which is what makes this work
 * uniformly across the shapes connectors actually write: a string compares
 * directly, and an array (mail's `to`, its `cc`) renders as its JSON text,
 * so `to:evan` matches a recipient list without needing a separate array
 * path. Numbers additionally get a numeric comparison when both sides look
 * numeric, so `version:>3` orders as a person expects rather than as
 * strings do.
 */
function leaf(token: MetadataFilterToken): RawBuilder<boolean> {
  // Keys come from user input and cannot be parameterised as identifiers —
  // but they are not identifiers here: `->>` takes the key as a VALUE, so
  // it parameterises like any other. No injection surface, no escaping.
  const key = token.key;
  const value = token.value;

  let comparison: RawBuilder<boolean>;
  if (token.operator === 'contains') {
    comparison = sql<boolean>`metadata ->> ${key} ILIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`;
  } else if (token.operator === '=') {
    // Case-insensitive on purpose: nobody types "ENG-787" and means to miss
    // "eng-787", and every value here is a name or an id, not a password.
    comparison = sql<boolean>`lower(metadata ->> ${key}) = lower(${value})`;
  } else {
    const numeric = Number(value);
    const operator = sql.raw(token.operator);
    comparison = Number.isFinite(numeric)
      ? sql<boolean>`(
          CASE WHEN metadata ->> ${key} ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (metadata ->> ${key})::numeric ${operator} ${numeric}
            ELSE metadata ->> ${key} ${operator} ${value}
          END
        )`
      : sql<boolean>`metadata ->> ${key} ${operator} ${value}`;
  }

  // A negated filter must also match rows that lack the key entirely:
  // "not from Evan" is true of a document with no `from` at all, and the
  // SQL NULL from a missing key would otherwise silently exclude it.
  return token.negated
    ? sql<boolean>`(metadata ->> ${key} IS NULL OR NOT (${comparison}))`
    : comparison;
}

/**
 * The whole tree as one boolean fragment, or null when it says nothing —
 * a caller uses null to mean "no metadata narrowing", keeping the unfiltered
 * query plan byte-identical to what it was before this existed.
 */
export function compileMetadataFilter(
  expr: MetadataFilterExpr | null | undefined
): RawBuilder<boolean> | null {
  if (!expr) return null;

  if (expr.type === 'filter') {
    if (!expr.filter.key || expr.filter.key === FREE_TEXT_KEY) return null;
    return leaf(expr.filter);
  }

  const compiled = expr.nodes
    .map(compileMetadataFilter)
    .filter((node): node is RawBuilder<boolean> => node !== null);
  if (compiled.length === 0) return null;
  if (compiled.length === 1) return compiled[0];

  const joiner = expr.type === 'and' ? sql` AND ` : sql` OR `;
  return sql<boolean>`(${sql.join(compiled, joiner)})`;
}

/**
 * jsonb's text rendering of a value (what `->>` returns for a non-string):
 * `, ` and `: ` separators, object keys in jsonb's storage order (shorter
 * first, then bytewise). Numbers render as JavaScript prints them, so a
 * stored `1.50` reads back as `1.5` here where Postgres keeps `1.50` — the
 * memory store's one known departure.
 */
function jsonbText(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** `metadata ->> key`: a string as-is, anything else as jsonb text, null when absent or JSON null. */
export function metadataText(metadata: unknown, key: string): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  if (!Object.hasOwn(metadata, key)) return null;
  const value: unknown = Reflect.get(metadata, key);
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : jsonbText(value);
}

const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;

function holds(order: number, operator: MetadataFilterOperator): boolean {
  switch (operator) {
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    default:
      return order === 0;
  }
}

/** One leaf in SQL's three-valued logic: null where Postgres would say NULL. */
function leafHolds(metadata: unknown, token: MetadataFilterToken): boolean | null {
  const text = metadataText(metadata, token.key);
  let comparison: boolean | null;
  if (text === null) comparison = null;
  else if (token.operator === 'contains') {
    comparison = like(text, `%${escapeLike(token.value)}%`);
  } else if (token.operator === '=') {
    comparison = text.toLowerCase() === token.value.toLowerCase();
  } else {
    const numeric = Number(token.value);
    comparison =
      Number.isFinite(numeric) && NUMERIC_TEXT.test(text)
        ? holds(Number(text) - numeric, token.operator)
        : holds(compareAsc(text, token.value), token.operator);
  }
  if (!token.negated) return comparison;
  return text === null ? true : comparison === null ? null : !comparison;
}

/** The compiled filter's verdict on one row's metadata, in JavaScript. */
export function metadataMatches(
  metadata: unknown,
  expr: MetadataFilterExpr | null | undefined
): boolean {
  const evaluate = (node: MetadataFilterExpr): boolean | null | 'skip' => {
    if (node.type === 'filter') {
      if (!node.filter.key || node.filter.key === FREE_TEXT_KEY) return 'skip';
      return leafHolds(metadata, node.filter);
    }
    const results = node.nodes.map(evaluate).filter((result) => result !== 'skip');
    if (results.length === 0) return 'skip';
    if (node.type === 'and') {
      if (results.includes(false)) return false;
      return results.includes(null) ? null : true;
    }
    if (results.includes(true)) return true;
    return results.includes(null) ? null : false;
  };
  if (!expr) return true;
  const verdict = evaluate(expr);
  return verdict === 'skip' || verdict === true;
}
