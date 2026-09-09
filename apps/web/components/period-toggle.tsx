'use client';

/**
 * The one period selector every usage surface shares — today through
 * all-time, one bucket at a time — so the oversight cards and an agent's
 * usage panel read the same way and the e2e specs can flip either by the
 * same button names.
 *
 * A group of pill buttons rather than a segmented bar: the bar had to be
 * one box, so it stretched across whatever width it was given and wrapped
 * mid-box in a narrow column. Pills take only the width their labels
 * need, wrap as a group, and the selected one is the one filled blue —
 * a light fill in light mode, a deep one in dark, each with text of the
 * same hue at the far end of the scale so it reads in both.
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
    <div role="group" aria-label="Period" className="flex flex-wrap gap-1.5">
      {PERIODS.map((period) => {
        const selected = value === period.key;
        return (
          <button
            key={period.key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(period.key)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              selected
                ? 'border-blue-300 bg-blue-100 font-medium text-blue-900 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100'
                : 'border-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100'
            }`}
          >
            {period.label}
          </button>
        );
      })}
    </div>
  );
}
