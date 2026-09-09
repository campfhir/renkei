/**
 * Ordering for the oversight table, kept pure so it is unit-tested away
 * from the component. Numeric columns sort largest first — the point of
 * sorting by tokens is finding the agent that costs the most, which is
 * always the top of a descending list — with the agent's name breaking
 * ties so the order is stable between renders. Name sorts ascending.
 */

import type { RunBuckets } from './oversight-table';

export type OversightSortKey = 'name' | 'runs' | 'failures' | 'tokensIn' | 'tokensOut';

export interface OversightTallies {
  runsByAgent: Record<string, RunBuckets>;
  failuresByAgent: Record<string, RunBuckets>;
  tokensInByAgent: Record<string, RunBuckets>;
  tokensOutByAgent: Record<string, RunBuckets>;
}

export function tallyOf(
  tallies: OversightTallies,
  key: Exclude<OversightSortKey, 'name'>,
  agentId: string,
  bucket: keyof RunBuckets
): number {
  const table = {
    runs: tallies.runsByAgent,
    failures: tallies.failuresByAgent,
    tokensIn: tallies.tokensInByAgent,
    tokensOut: tallies.tokensOutByAgent,
  }[key];
  return table[agentId]?.[bucket] ?? 0;
}

export function sortAgentRows<T extends { id: string; name: string }>(
  agents: readonly T[],
  key: OversightSortKey,
  bucket: keyof RunBuckets,
  tallies: OversightTallies
): T[] {
  const byName = (left: T, right: T) =>
    left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
  if (key === 'name') return [...agents].sort(byName);
  return [...agents].sort(
    (left, right) =>
      tallyOf(tallies, key, right.id, bucket) - tallyOf(tallies, key, left.id, bucket) ||
      byName(left, right)
  );
}
