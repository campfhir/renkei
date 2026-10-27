/**
 * `key:value` filters over a chunk's metadata: splitting a parsed query
 * into the words for the vector and the filters for SQL.
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

import {
  FREE_TEXT_KEY,
  type MetadataFilterExpr,
  type MetadataFilterOperator,
  type MetadataFilterToken,
} from '@renkei/db';

// The compiler moved beside the query that runs it (the data store's
// knowledge domain); it is re-exported here so callers keep one import.
export { compileMetadataFilter, FREE_TEXT_KEY } from '@renkei/db';
export type { MetadataFilterExpr, MetadataFilterOperator, MetadataFilterToken };

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
