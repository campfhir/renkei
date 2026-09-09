/**
 * Ordering for the oversight cards, kept pure so it is unit-tested away
 * from the component. Numeric sorts put the largest first — the point of
 * sorting by tokens is finding the agent that costs the most, which is
 * always the top of a descending list — with the agent's name breaking
 * ties so the order is stable between renders. Name sorts ascending.
 */

import type { TokenUsage, UsageBuckets } from '@/lib/agents/agent-usage';

export type OversightSortKey = 'name' | 'runs' | 'failures' | 'tokensIn' | 'tokensOut';

export interface OversightTallies {
  runsByAgent: Record<string, UsageBuckets>;
  failuresByAgent: Record<string, UsageBuckets>;
  tokensByAgent: Record<string, TokenUsage>;
}

export function tallyOf(
  tallies: OversightTallies,
  key: Exclude<OversightSortKey, 'name'>,
  agentId: string,
  bucket: keyof UsageBuckets
): number {
  switch (key) {
    case 'runs':
      return tallies.runsByAgent[agentId]?.[bucket] ?? 0;
    case 'failures':
      return tallies.failuresByAgent[agentId]?.[bucket] ?? 0;
    case 'tokensIn':
      return tallies.tokensByAgent[agentId]?.input[bucket] ?? 0;
    case 'tokensOut':
      return tallies.tokensByAgent[agentId]?.output[bucket] ?? 0;
  }
}

export function sortAgentRows<T extends { id: string; name: string }>(
  agents: readonly T[],
  key: OversightSortKey,
  bucket: keyof UsageBuckets,
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
