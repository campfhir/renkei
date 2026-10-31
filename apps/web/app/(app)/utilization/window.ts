/**
 * The usage page's period and bucket arithmetic — kept apart from the
 * server action so it runs in a test without a database, the same split
 * the tools page (usage/window.ts), Organization Usage
 * (admin/usage/window.ts), and the person page (trend-window.ts) make.
 * The chart's buckets and the activity calendar come from the Organization
 * Usage window (admin/usage/window.ts), so both pages bucket identically.
 */

import type { UsageSpan } from '@/lib/usage/user-utilization';

export { formatTokens } from '@/lib/format-tokens';
export type { UsageSpan };

export interface UtilizationPeriod extends UsageSpan {
  key: string;
  label: string;
}

/**
 * The windows the page offers. Today and yesterday are single days drawn
 * by the hour; the rest run up to and including today. A one-day window
 * that ends before today is what `endOffsetDays` is for — "yesterday" is
 * the only period whose newest day is not today.
 */
export const UTILIZATION_PERIODS: readonly UtilizationPeriod[] = [
  { key: 'today', label: 'Today', days: 1, endOffsetDays: 0 },
  { key: 'yesterday', label: 'Yesterday', days: 1, endOffsetDays: 1 },
  { key: '1w', label: '7 days', days: 7, endOffsetDays: 0 },
  { key: '1m', label: '30 days', days: 30, endOffsetDays: 0 },
  { key: '1q', label: '90 days', days: 90, endOffsetDays: 0 },
  { key: '1y', label: '1 year', days: 365, endOffsetDays: 0 },
];

export const DEFAULT_PERIOD_KEY = '1m';

/** A period key as typed by a client call — never trusted, always resolved. */
export function resolvePeriod(key: string | undefined): UtilizationPeriod {
  return (
    UTILIZATION_PERIODS.find((period) => period.key === key) ??
    UTILIZATION_PERIODS.find((period) => period.key === DEFAULT_PERIOD_KEY)!
  );
}

/** "Over the last 30 days", or "Today, by hour" for a one-day window. */
export function periodCaption(period: Pick<UtilizationPeriod, 'label' | 'days'>): string {
  return period.days <= 1 ? `${period.label}, by hour` : `Over the last ${period.label}`;
}

export type Granularity = 'hour' | 'day' | 'week' | 'month';

/** How wide a bucket has to be for a bar chart of the period to stay readable. */
export function granularityFor(days: number): Granularity {
  if (days <= 1) return 'hour';
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/** What the SQL groups rows by: the hour for a one-day window, the day otherwise. */
export function seriesGranularity(days: number): 'hour' | 'day' {
  return days <= 1 ? 'hour' : 'day';
}

/** Average tokens a run costs — the efficiency number; 0 when nothing ran. */
export function tokensPerRun(inputTokens: number, outputTokens: number, runs: number): number {
  if (runs <= 0) return 0;
  return Math.round((inputTokens + outputTokens) / runs);
}

/** The engine's error taxonomy, in words the owner will recognize. */
export function failureKindLabel(kind: string | null): string {
  switch (kind) {
    case 'step_failed':
      return 'a step failed';
    case 'llm_auth':
      return 'model credentials rejected';
    case 'llm_rate_limit':
      return 'model rate-limited';
    case 'llm_error':
      return 'model error';
    case 'timeout':
      return 'timed out';
    case 'guard':
      return 'hit a limit';
    case 'config':
      return 'configuration';
    case null:
      return 'failed';
    default:
      return kind.replace(/_/g, ' ');
  }
}
