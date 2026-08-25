/**
 * `key:value` filters over a chunk's metadata, compiled to SQL.
 *
 * The syntax and its parser are bored-logs' — the same thing the activity log
 * search speaks, so anyone who has filtered logs here already knows how to
 * filter knowledge. Only the COMPILATION is ours: logs match against their
 * attributes table, and these match against `knowledge_chunks.metadata`.
 *
 * The tree type is declared structurally rather than imported, so the
 * knowledge package does not take a dependency on a logging library for the
 * sake of a three-member union. The web app parses; this compiles.
 *
 * A bare word is NOT handled here. The parser turns bare words into
 * `$message` leaves, and the caller lifts those out to use as the semantic
 * query — searching the vector is what a bare word means, and no amount of
 * SQL over metadata would do that job.
 */

import { sql, type RawBuilder } from 'kysely';

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
 * Split a parsed query into the words that should hit the VECTOR and the
 * filters that should narrow metadata.
 *
 * "printers not working ticket:ENG-787" means: search semantically for
 * "printers not working", among chunks whose ticket contains ENG-787. The
 * two halves answer different questions and neither substitutes for the
 * other, which is why they are separated here rather than blended.
 */
export function splitQuery(expr: MetadataFilterExpr | null | undefined): {
  terms: string[];
  filter: MetadataFilterExpr | null;
  /**
   * Set when the query asked for something this split cannot honour: a bare
   * word OR-ed with a filter.
   *
   * The two halves recombine as AND by construction — the filter narrows
   * which rows are candidates, then the vector ranks them — so `printers ||
   * ticket:ENG-787` cannot be answered as written. Lifting the word out
   * anyway would quietly return "about printers AND on that ticket", which
   * is a different and much smaller answer to a question nobody asked. Say
   * so instead.
   */
  unsupported: string | null;
} {
  const terms: string[] = [];
  let unsupported: string | null = null;

  const hasFreeText = (node: MetadataFilterExpr): boolean =>
    node.type === 'filter' ? node.filter.key === FREE_TEXT_KEY : node.nodes.some(hasFreeText);
  const hasMetadata = (node: MetadataFilterExpr): boolean =>
    node.type === 'filter' ? node.filter.key !== FREE_TEXT_KEY : node.nodes.some(hasMetadata);

  const walk = (node: MetadataFilterExpr): MetadataFilterExpr | null => {
    if (node.type === 'filter') {
      if (node.filter.key === FREE_TEXT_KEY) {
        // A negated bare word has no meaning for a vector search — there is
        // no "unlike this" direction — so it is dropped rather than
        // silently inverted.
        if (!node.filter.negated) terms.push(node.filter.value);
        return null;
      }
      return node;
    }
    // An OR spanning both halves is the one shape that cannot be split. An
    // AND is fine: narrowing then ranking IS an AND.
    if (node.type === 'or' && node.nodes.length > 1) {
      if (hasFreeText(node) && hasMetadata(node)) {
        unsupported =
          'A word cannot be combined with || against a filter — searching meaning and ' +
          'matching a field are answered in different ways, so they always narrow together. ' +
          'Use && , or search for the two things separately.';
        return null;
      }
    }
    const kept = node.nodes
      .map(walk)
      .filter((child): child is MetadataFilterExpr => child !== null);
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    return { type: node.type, nodes: kept };
  };
  const filter = expr ? walk(expr) : null;
  return { terms, filter, unsupported };
}
