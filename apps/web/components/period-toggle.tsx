'use client';

/**
 * The one period selector every usage surface shares — today through
 * all-time, one bucket at a time — so the oversight cards and an agent's
 * usage panel read the same way and the e2e specs can flip either by the
 * same button names.
 */

import type { UsageBuckets } from '@/lib/agents/agent-usage';

export const PERIODS: { key: keyof UsageBuckets; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'allTime', label: 'All time' },
];

export function periodLabel(key: keyof UsageBuckets): string {
  return PERIODS.find((period) => period.key === key)?.label ?? key;
}

export default function PeriodToggle({
  value,
  onChange,
}: {
  value: keyof UsageBuckets;
  onChange: (key: keyof UsageBuckets) => void;
}): React.ReactNode {
  return (
    <div
      role="group"
      aria-label="Period"
      className="flex flex-wrap overflow-hidden rounded-md border border-gray-300 text-xs dark:border-gray-700"
    >
      {PERIODS.map((period) => (
        <button
          key={period.key}
          type="button"
          aria-pressed={value === period.key}
          onClick={() => onChange(period.key)}
          className={`px-2.5 py-1 ${
            value === period.key
              ? 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          }`}
        >
          {period.label}
        </button>
      ))}
    </div>
  );
}
