/**
 * The seven calendar periods every usage surface offers — today through
 * all-time — as one list, so the period pills on the pages and the
 * `period` argument of the agents-over-MCP usage tool name the same
 * buckets by the same labels. Plain data, importable from server and
 * client alike.
 */

import type { UsageBuckets } from './agent-usage';

export type UsagePeriod = keyof UsageBuckets;

export const PERIODS: { key: UsagePeriod; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'allTime', label: 'All time' },
];

/** The same keys as a non-empty tuple, the shape a zod enum takes. */
export const PERIOD_KEYS: [UsagePeriod, ...UsagePeriod[]] = [
  'today',
  'yesterday',
  'week',
  'month',
  'quarter',
  'year',
  'allTime',
];

export function periodLabel(key: UsagePeriod): string {
  return PERIODS.find((period) => period.key === key)?.label ?? key;
}

export function isUsagePeriod(value: unknown): value is UsagePeriod {
  return typeof value === 'string' && PERIODS.some((period) => period.key === value);
}
