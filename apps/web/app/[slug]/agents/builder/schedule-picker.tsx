'use client';

/**
 * The schedule editor — a LIST of structured rules (union, earliest wins)
 * plus the schedule-wide knobs: timezone, start date, active hours (windows
 * an "every hour" rule must land in), and blackouts (an org holiday
 * calendar and/or extra dates, with a skip/shift policy).
 *
 * No cron anywhere: the structured objects are what the server stores and
 * computes next_run_at from. The live "next run" preview calls the SAME
 * computeNextRunForSchedule the server and sweep use — imported from
 * @renkei/agents, pure and browser-safe — so the preview can never
 * disagree with what will actually happen.
 */

import RemoveButton from '@/components/remove-button';
import { useId, useMemo, useState } from 'react';
import {
  blackoutPredicate,
  computeNextRunForSchedule,
  MAX_ACTIVE_HOURS,
  MAX_SCHEDULE_BLACKOUTS,
  MAX_SCHEDULE_RULES,
  type ActiveHoursWindow,
  type BlackoutEntry,
  type Recurrence,
  type ScheduleConfig,
  type Weekday,
} from '@renkei/agents';

const selectClass =
  'rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ordinal(day: number): string {
  const tail = day % 10;
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  return `${day}${tail === 1 ? 'st' : tail === 2 ? 'nd' : tail === 3 ? 'rd' : 'th'}`;
}

function timezoneOptions(current: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC'];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

/**
 * The flat rule-kind vocabulary — every kind visible in ONE select, the
 * verto presentation. Nesting the monthly forms behind an "Every month"
 * mode select hid them well enough to read as missing.
 */
type RuleKind =
  | 'hour'
  | 'day'
  | 'weekday'
  | 'week'
  | 'month-day'
  | 'month-nth'
  | 'first-weekday'
  | 'last-weekday'
  | 'last-day';

function ruleKindOf(rule: Recurrence): RuleKind {
  switch (rule.every) {
    case 'hour':
      return 'hour';
    case 'day':
      return 'day';
    case 'weekday':
      return 'weekday';
    case 'week':
      return 'week';
    case 'month':
      if ('day' in rule) return 'month-day';
      if ('nth' in rule) return 'month-nth';
      return rule.on;
  }
}

/** One rule's editing row: kind, its conditional fields, the time. */
function RuleRow({ rule, onChange }: { rule: Recurrence; onChange: (rule: Recurrence) => void }) {
  const at = 'at' in rule ? rule.at : '09:00';

  // A kind change wipes the variant's fields and re-defaults them (the
  // verto pattern), always carrying the time across.
  const switchKind = (kind: RuleKind) => {
    switch (kind) {
      case 'hour':
        onChange({ every: 'hour' });
        break;
      case 'day':
        onChange({ every: 'day', at });
        break;
      case 'weekday':
        onChange({ every: 'weekday', at });
        break;
      case 'week':
        onChange({ every: 'week', weekday: 1, at });
        break;
      case 'month-day':
        onChange({ every: 'month', day: 1, at });
        break;
      case 'month-nth':
        onChange({ every: 'month', nth: 1, weekday: 1, at });
        break;
      case 'first-weekday':
      case 'last-weekday':
      case 'last-day':
        onChange({ every: 'month', on: kind, at });
        break;
    }
  };

  const weekdaySelect = (value: Weekday, apply: (weekday: Weekday) => void, label: string) => (
    <select
      aria-label={label}
      className={selectClass}
      value={value}
      onChange={(event) => {
        const weekday = Number(event.target.value);
        if (weekday >= 0 && weekday <= 6) {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- bounds-checked on the line above
          apply(weekday as Weekday);
        }
      }}
    >
      {WEEKDAYS.map((day, weekday) => (
        <option key={day} value={weekday}>
          {day}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="How often"
        className={selectClass}
        value={ruleKindOf(rule)}
        onChange={(event) => {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the select only offers RuleKind values
          switchKind(event.target.value as RuleKind);
        }}
      >
        <option value="hour">Every hour</option>
        <option value="day">Every day</option>
        <option value="weekday">Every weekday (Mon–Fri)</option>
        <option value="week">Weekly on a day…</option>
        <option value="month-day">Monthly on a date…</option>
        <option value="month-nth">Monthly on the Nth weekday…</option>
        <option value="first-weekday">First weekday of the month</option>
        <option value="last-weekday">Last weekday of the month</option>
        <option value="last-day">Last day of the month</option>
      </select>

      {rule.every === 'week'
        ? weekdaySelect(rule.weekday, (weekday) => onChange({ ...rule, weekday }), 'Which day')
        : null}

      {rule.every === 'month' && 'day' in rule ? (
        <select
          aria-label="Day number"
          className={selectClass}
          value={rule.day}
          onChange={(event) => onChange({ every: 'month', day: Number(event.target.value), at })}
        >
          {Array.from({ length: 31 }, (_, dayIndex) => dayIndex + 1).map((day) => (
            <option key={day} value={day}>
              the {ordinal(day)}
              {day > 28 ? ' (or last day)' : ''}
            </option>
          ))}
        </select>
      ) : null}

      {rule.every === 'month' && 'nth' in rule ? (
        <>
          <select
            aria-label="Which week"
            className={selectClass}
            value={rule.nth}
            onChange={(event) => {
              const nth = Number(event.target.value);
              if (nth === 1 || nth === 2 || nth === 3 || nth === 4 || nth === -1) {
                onChange({ ...rule, nth });
              }
            }}
          >
            <option value={1}>the 1st</option>
            <option value={2}>the 2nd</option>
            <option value={3}>the 3rd</option>
            <option value={4}>the 4th</option>
            <option value={-1}>the last</option>
          </select>
          {weekdaySelect(
            rule.weekday,
            (weekday) => onChange({ ...rule, weekday }),
            'Which weekday'
          )}
        </>
      ) : null}

      {rule.every !== 'hour' ? (
        <input
          type="time"
          aria-label="At what time"
          className={selectClass}
          value={at}
          onChange={(event) => {
            const nextAt = event.target.value;
            if (!nextAt) return;
            onChange({ ...rule, at: nextAt });
          }}
        />
      ) : null}
    </div>
  );
}

export interface CalendarOption {
  id: string;
  name: string;
  dates: BlackoutEntry[];
}

function describeBlackout(entry: BlackoutEntry): string {
  if ('date' in entry && typeof entry.date === 'string') return entry.date;
  if ('start' in entry && typeof entry.start === 'string') return `${entry.start} → ${entry.end}`;
  if ('annual' in entry && typeof entry.annual === 'string') return `every ${entry.annual}`;
  return '?';
}

/** The extra-dates chip editor: one-off, range, or annual entries. */
function BlackoutEditor({
  blackouts,
  onChange,
}: {
  blackouts: BlackoutEntry[];
  onChange: (blackouts: BlackoutEntry[]) => void;
}) {
  const [mode, setMode] = useState<'date' | 'range' | 'annual'>('date');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');

  const add = () => {
    if (!first) return;
    let entry: BlackoutEntry | null = null;
    if (mode === 'date') entry = { date: first };
    if (mode === 'range' && second && first <= second) entry = { start: first, end: second };
    if (mode === 'annual') entry = { annual: first.slice(5) };
    if (!entry) return;
    onChange([...blackouts, entry]);
    setFirst('');
    setSecond('');
  };

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1">
        {blackouts.map((entry, index) => (
          <span
            key={`${describeBlackout(entry)}-${index}`}
            className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
          >
            {describeBlackout(entry)}
            <button
              type="button"
              aria-label={`Remove blackout ${describeBlackout(entry)}`}
              onClick={() => onChange(blackouts.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {blackouts.length < MAX_SCHEDULE_BLACKOUTS ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select
            aria-label="Blackout type"
            className={selectClass}
            value={mode}
            onChange={(event) => {
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the select only offers these values
              setMode(event.target.value as 'date' | 'range' | 'annual');
              setFirst('');
              setSecond('');
            }}
          >
            <option value="date">a date</option>
            <option value="range">a range</option>
            <option value="annual">every year on</option>
          </select>
          <input
            type="date"
            aria-label={mode === 'range' ? 'Blackout start' : 'Blackout date'}
            className={selectClass}
            value={first}
            onChange={(event) => setFirst(event.target.value)}
          />
          {mode === 'range' ? (
            <input
              type="date"
              aria-label="Blackout end"
              className={selectClass}
              value={second}
              onChange={(event) => setSecond(event.target.value)}
            />
          ) : null}
          <button
            type="button"
            onClick={add}
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            + Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** '24:00' has no Date to format, and reads more clearly as "midnight". */
function formatClock(hhmm: string): string {
  if (hhmm === '24:00') return 'midnight';
  const [hour, minute] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(2000, 0, 1, hour, minute)
  );
}

function describeWindow(window: ActiveHoursWindow): string {
  return `${formatClock(window.start)} – ${formatClock(window.end)}`;
}

/** The active-hours chip editor: start/end time pickers, capped, removable. */
function ActiveHoursEditor({
  windows,
  onChange,
}: {
  windows: ActiveHoursWindow[];
  onChange: (windows: ActiveHoursWindow[]) => void;
}) {
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [untilMidnight, setUntilMidnight] = useState(false);

  const add = () => {
    const effectiveEnd = untilMidnight ? '24:00' : end;
    if (!start || !effectiveEnd || start >= effectiveEnd) return;
    onChange([...windows, { start, end: effectiveEnd }]);
    setUntilMidnight(false);
  };

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1">
        {windows.map((window, index) => (
          <span
            key={`${window.start}-${window.end}-${index}`}
            className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"
          >
            {describeWindow(window)}
            <button
              type="button"
              aria-label={`Remove active-hours window ${describeWindow(window)}`}
              onClick={() => onChange(windows.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {windows.length < MAX_ACTIVE_HOURS ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            type="time"
            aria-label="Window start"
            className={selectClass}
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
          <span className="text-xs text-gray-500 dark:text-gray-400">to</span>
          <input
            type="time"
            aria-label="Window end"
            className={selectClass}
            value={end}
            disabled={untilMidnight}
            onChange={(event) => setEnd(event.target.value)}
          />
          <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={untilMidnight}
              onChange={(event) => setUntilMidnight(event.target.checked)}
            />
            Until midnight
          </label>
          <button
            type="button"
            onClick={add}
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            + Add window
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {MAX_ACTIVE_HOURS} of {MAX_ACTIVE_HOURS} windows — the limit.
        </p>
      )}
    </div>
  );
}

export function ScheduleEditor({
  value,
  onChange,
  calendars,
}: {
  value: ScheduleConfig;
  onChange: (config: ScheduleConfig) => void;
  /** The org's holiday calendars, dates included (for the preview). */
  calendars: CalendarOption[];
}) {
  const rules = value.recurrences;
  const setRules = (recurrences: Recurrence[]) => onChange({ ...value, recurrences });
  // Two schedule triggers on one page must not share a radio group.
  const policyGroup = useId();

  const calendarDates = useMemo(
    () => calendars.find((calendar) => calendar.id === value.calendarId)?.dates ?? [],
    [calendars, value.calendarId]
  );

  // The preview: same function, same inputs as the server. Computed with
  // and without blackouts so a shifted date can say what it shifted from.
  const preview = useMemo(() => {
    try {
      const next = computeNextRunForSchedule(value, new Date(), blackoutPredicate(calendarDates));
      let naturalNext: Date | null = null;
      try {
        naturalNext = computeNextRunForSchedule(
          { ...value, blackouts: undefined, calendarId: undefined },
          new Date()
        );
      } catch {
        naturalNext = null;
      }
      return {
        next,
        shiftedFrom: naturalNext && naturalNext.getTime() !== next.getTime() ? naturalNext : null,
      };
    } catch {
      return null;
    }
  }, [value, calendarDates]);

  const formatInZone = (date: Date) => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: value.timezone,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString();
    }
  };

  const hasBlackouts = Boolean(value.calendarId) || (value.blackouts?.length ?? 0) > 0;

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {rules.map((rule, index) => (
          <li
            key={index}
            className="flex items-start justify-between gap-2 rounded-md border border-gray-100 p-2 dark:border-gray-900"
          >
            <RuleRow
              rule={rule}
              onChange={(next) => setRules(rules.map((entry, at) => (at === index ? next : entry)))}
            />
            {rules.length > 1 ? (
              <RemoveButton
                compact
                label="Remove rule"
                onClick={() => setRules(rules.filter((_, at) => at !== index))}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {rules.length < MAX_SCHEDULE_RULES ? (
        <button
          type="button"
          onClick={() => setRules([...rules, { every: 'day', at: '09:00' }])}
          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add a rule ({rules.length} of {MAX_SCHEDULE_RULES})
        </button>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {MAX_SCHEDULE_RULES} of {MAX_SCHEDULE_RULES} rules — the limit.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Timezone"
          className={selectClass}
          value={value.timezone}
          onChange={(event) => onChange({ ...value, timezone: event.target.value })}
        >
          {timezoneOptions(value.timezone).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
          Don&apos;t start before
          <input
            type="date"
            aria-label="Start date"
            className={selectClass}
            value={value.startAt ?? ''}
            onChange={(event) => {
              const { startAt: _startAt, ...rest } = value;
              onChange(event.target.value ? { ...rest, startAt: event.target.value } : rest);
            }}
          />
        </label>
      </div>

      {rules.some((rule) => rule.every === 'hour') ? (
        <div className="rounded-md border border-sky-200 p-2 dark:border-sky-900">
          <p className="text-xs font-semibold text-sky-700 dark:text-sky-400">Active hours</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Constrains &ldquo;every hour&rdquo; rules to these windows. Leave empty to run around
            the clock.
          </p>
          <ActiveHoursEditor
            windows={value.activeHours ?? []}
            onChange={(activeHours) => {
              const { activeHours: _activeHours, ...rest } = value;
              onChange(activeHours.length > 0 ? { ...rest, activeHours } : rest);
            }}
          />
        </div>
      ) : null}

      <div className="rounded-md border border-gray-100 p-2 dark:border-gray-900">
        <p className="text-xs font-semibold text-gray-600 dark:text-gray-400">Blackout dates</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select
            aria-label="Holiday calendar"
            className={selectClass}
            value={value.calendarId ?? ''}
            onChange={(event) => {
              const { calendarId: _calendarId, ...rest } = value;
              onChange(event.target.value ? { ...rest, calendarId: event.target.value } : rest);
            }}
          >
            <option value="">No holiday calendar</option>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </select>
        </div>
        <BlackoutEditor
          blackouts={value.blackouts ?? []}
          onChange={(blackouts) => {
            const { blackouts: _blackouts, ...rest } = value;
            onChange(blackouts.length > 0 ? { ...rest, blackouts } : rest);
          }}
        />
        {hasBlackouts ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-600 dark:text-gray-400">
            <span>On a blackout date:</span>
            {(
              [
                ['after', 'run the next clear day'],
                ['before', 'run the previous clear day'],
                ['skip', 'skip the run'],
              ] as const
            ).map(([policy, label]) => (
              <label key={policy} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={policyGroup}
                  checked={(value.blackoutPolicy ?? 'after') === policy}
                  onChange={() => onChange({ ...value, blackoutPolicy: policy })}
                />
                {label}
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <p className="text-xs text-gray-600 dark:text-gray-400">
        {preview ? (
          <>
            Next run: <strong>{formatInZone(preview.next)}</strong> ({value.timezone})
            {preview.shiftedFrom ? (
              <> — shifted from {formatInZone(preview.shiftedFrom)} by a blackout</>
            ) : null}
          </>
        ) : (
          'No upcoming run — check the rules and blackout dates.'
        )}
      </p>
    </div>
  );
}
