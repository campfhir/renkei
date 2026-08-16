'use client';

/**
 * Recurrence presets — every hour / day / week / month — with the fields
 * each needs. No cron anywhere: the structured object is what the server
 * stores and computes next_run_at from, and the day-of-month tops out at
 * 28 so February is never a surprise.
 */

import type { Recurrence } from '@renkei/agents';

const selectClass =
  'rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function SchedulePicker({
  value,
  onChange,
}: {
  value: Recurrence;
  onChange: (recurrence: Recurrence) => void;
}) {
  const at = 'at' in value ? value.at : '09:00';

  const switchKind = (kind: string) => {
    switch (kind) {
      case 'hour':
        onChange({ every: 'hour' });
        break;
      case 'day':
        onChange({ every: 'day', at });
        break;
      case 'week':
        onChange({ every: 'week', weekday: 1, at });
        break;
      case 'month':
        onChange({ every: 'month', day: 1, at });
        break;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="How often"
        className={selectClass}
        value={value.every}
        onChange={(event) => switchKind(event.target.value)}
      >
        <option value="hour">Every hour</option>
        <option value="day">Every day</option>
        <option value="week">Every week</option>
        <option value="month">Every month</option>
      </select>

      {value.every === 'week' ? (
        <select
          aria-label="Which day"
          className={selectClass}
          value={value.weekday}
          onChange={(event) => {
            const weekday = Number(event.target.value);
            if (weekday >= 0 && weekday <= 6) {
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- bounds-checked on the line above
              onChange({ ...value, weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6 });
            }
          }}
        >
          {WEEKDAYS.map((day, weekday) => (
            <option key={day} value={weekday}>
              on {day}
            </option>
          ))}
        </select>
      ) : null}

      {value.every === 'month' ? (
        <select
          aria-label="Which day of the month"
          className={selectClass}
          value={value.day}
          onChange={(event) => onChange({ ...value, day: Number(event.target.value) })}
        >
          {Array.from({ length: 28 }, (_, dayIndex) => dayIndex + 1).map((day) => (
            <option key={day} value={day}>
              on the {day}
              {day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th'}
            </option>
          ))}
        </select>
      ) : null}

      {value.every !== 'hour' ? (
        <input
          type="time"
          aria-label="At what time"
          className={selectClass}
          value={at}
          onChange={(event) => {
            const nextAt = event.target.value;
            if (!nextAt) return;
            onChange({ ...value, at: nextAt });
          }}
        />
      ) : null}
    </div>
  );
}
