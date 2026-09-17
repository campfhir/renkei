/**
 * Which days (or hours) a person did anything, as colored squares — the
 * contribution-graph idiom, without the axis labels: a square per
 * calendar day, shaded by that day's tokens, blank when nothing happened.
 *
 * Three shapes, chosen by the window: a one-day window is a single strip
 * of 24 hours; a week is a single strip of seven days; anything longer is
 * laid out as tiny month calendars side by side, each seven columns wide
 * and aligned to the real weekday of each date, so a square is read the
 * way a calendar is. Every square carries its own tooltip, which is where
 * the numbers live.
 */

import { calendarMonths, formatTokens, type ActivityCell } from '@/app/[slug]/admin/usage/window';

const LEVEL_CLASS: Record<ActivityCell['level'], string> = {
  0: 'bg-gray-100 dark:bg-gray-800',
  1: 'bg-blue-200 dark:bg-blue-900',
  2: 'bg-blue-400 dark:bg-blue-700',
  3: 'bg-blue-500 dark:bg-blue-500',
  4: 'bg-blue-700 dark:bg-blue-300',
};

function tooltipOf(cell: ActivityCell): string {
  if (!cell.active) return `${cell.label}: nothing`;
  const parts: string[] = [];
  if (cell.tokens > 0) parts.push(`${formatTokens(cell.tokens)} tokens`);
  if (cell.runs > 0) parts.push(`${cell.runs.toLocaleString('en-US')} runs`);
  if (cell.toolCalls > 0) parts.push(`${cell.toolCalls.toLocaleString('en-US')} tool calls`);
  return `${cell.label}: ${parts.join(', ')}`;
}

function Square({ cell }: { cell: ActivityCell }) {
  return (
    <div
      className={`h-3 w-3 rounded-[2px] ${LEVEL_CLASS[cell.level]}`}
      title={tooltipOf(cell)}
      role="img"
      aria-label={tooltipOf(cell)}
    />
  );
}

export function ActivityCalendar({
  cells,
  hourly,
}: {
  cells: ActivityCell[];
  /** The cells are the hours of one day rather than days. */
  hourly: boolean;
}) {
  if (cells.length === 0) return null;

  if (hourly || cells.length <= 7) {
    return (
      <div className="flex flex-wrap gap-1" role="group" aria-label="Activity">
        {cells.map((cell) => (
          <Square key={cell.key} cell={cell} />
        ))}
      </div>
    );
  }

  const months = calendarMonths(cells);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-3" role="group" aria-label="Activity by day">
      {months.map((month) => (
        <div key={month.key}>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {month.label}
          </p>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: month.leading }, (_, index) => (
              <div key={`lead-${index}`} className="h-3 w-3" aria-hidden="true" />
            ))}
            {month.days.map((cell, index) =>
              cell ? (
                <Square key={cell.key} cell={cell} />
              ) : (
                <div key={`blank-${index}`} className="h-3 w-3" aria-hidden="true" />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
