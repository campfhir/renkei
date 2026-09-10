/**
 * Searching the connector catalog.
 *
 * A plain token scorer, the same shape as chat's `find_tools`: every query
 * word that appears in an entry's label, keywords, summary or tool prefix
 * counts, a hit on the label counts double, and ties keep catalog order.
 * Not fuzzy and not embeddings — twenty entries do not need either, and a
 * scorer somebody can read is one somebody can predict.
 */

import type { ConnectorEntry } from './connector-catalog';

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/** How well one entry matches a query; 0 means not at all. */
export function scoreConnector(entry: ConnectorEntry, query: string): number {
  const words = terms(query);
  if (words.length === 0) return 1;
  const label = entry.label.toLowerCase();
  const rest = [entry.keywords.join(' '), entry.summary, entry.toolPrefix, entry.capabilityKey]
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const word of words) {
    if (label.includes(word)) score += 2;
    else if (rest.includes(word)) score += 1;
  }
  return score;
}

/**
 * Entries matching the query, best first; an empty query returns everything
 * in catalog order.
 */
export function searchConnectors(entries: ConnectorEntry[], query: string): ConnectorEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreConnector(entry, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.entry);
}
