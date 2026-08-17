'use client';

/**
 * Holiday-calendar CRUD — the rule-forms shape: client-side list plus one
 * draft form serving both create and edit. Dates use the same three entry
 * forms the schedule editor's per-trigger blackouts use: a one-off date, a
 * range, or an annual MM-DD.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BlackoutEntry } from '@renkei/agents';
import { getJson, sendJson } from '@/lib/fetch-json';

const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

interface CalendarRow {
  id: string;
  name: string;
  dates: BlackoutEntry[];
}

interface Draft {
  id: string | null;
  name: string;
  dates: BlackoutEntry[];
}

function describeEntry(entry: BlackoutEntry): string {
  const label = 'label' in entry && entry.label ? ` (${entry.label})` : '';
  if ('date' in entry && typeof entry.date === 'string') return `${entry.date}${label}`;
  if ('start' in entry && typeof entry.start === 'string') {
    return `${entry.start} → ${entry.end}${label}`;
  }
  if ('annual' in entry && typeof entry.annual === 'string') {
    return `every ${entry.annual}${label}`;
  }
  return '?';
}

function EntryEditor({
  dates,
  onChange,
}: {
  dates: BlackoutEntry[];
  onChange: (dates: BlackoutEntry[]) => void;
}) {
  const [mode, setMode] = useState<'date' | 'range' | 'annual'>('annual');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [label, setLabel] = useState('');

  const add = () => {
    if (!first) return;
    const named = label.trim() ? { label: label.trim() } : {};
    let entry: BlackoutEntry | null = null;
    if (mode === 'date') entry = { date: first, ...named };
    if (mode === 'range' && second && first <= second) {
      entry = { start: first, end: second, ...named };
    }
    if (mode === 'annual') entry = { annual: first.slice(5), ...named };
    if (!entry) return;
    onChange([...dates, entry]);
    setFirst('');
    setSecond('');
    setLabel('');
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1">
        {dates.map((entry, index) => (
          <span
            key={`${describeEntry(entry)}-${index}`}
            className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
          >
            {describeEntry(entry)}
            <button
              type="button"
              aria-label={`Remove ${describeEntry(entry)}`}
              onClick={() => onChange(dates.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </span>
        ))}
        {dates.length === 0 ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">No dates yet.</span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Entry type"
          className={inputClass}
          value={mode}
          onChange={(event) => {
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the select only offers these values
            setMode(event.target.value as 'date' | 'range' | 'annual');
            setFirst('');
            setSecond('');
          }}
        >
          <option value="annual">every year on</option>
          <option value="date">a single date</option>
          <option value="range">a range</option>
        </select>
        <input
          type="date"
          aria-label={mode === 'range' ? 'Start date' : 'Date'}
          className={inputClass}
          value={first}
          onChange={(event) => setFirst(event.target.value)}
        />
        {mode === 'range' ? (
          <input
            type="date"
            aria-label="End date"
            className={inputClass}
            value={second}
            onChange={(event) => setSecond(event.target.value)}
          />
        ) : null}
        <input
          aria-label="Label"
          className={inputClass}
          placeholder="Label (optional)"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button
          type="button"
          onClick={add}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add date
        </button>
      </div>
      {mode === 'annual' ? (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Pick any year&apos;s occurrence — only the month and day are kept.
        </p>
      ) : null}
    </div>
  );
}

export default function CalendarForms({ slug }: { slug: string }) {
  const [calendars, setCalendars] = useState<CalendarRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ calendars: CalendarRow[] }>(
      `/api/admin/${slug}/schedule-calendars`
    );
    if (loadError) setError(loadError);
    else setCalendars(data?.calendars ?? []);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const saveError = draft.id
      ? await sendJson(`/api/admin/${slug}/schedule-calendars/${draft.id}`, 'PUT', {
          name: draft.name,
          dates: draft.dates,
        })
      : await sendJson(`/api/admin/${slug}/schedule-calendars`, 'POST', {
          name: draft.name,
          dates: draft.dates,
        });
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setDraft(null);
    await load();
  };

  const remove = async (calendarId: string) => {
    setBusy(true);
    setError(null);
    const removeError = await sendJson(
      `/api/admin/${slug}/schedule-calendars/${calendarId}`,
      'DELETE'
    );
    setBusy(false);
    if (removeError) {
      setError(removeError);
      return;
    }
    if (draft?.id === calendarId) setDraft(null);
    await load();
  };

  return (
    <div className="space-y-4">
      {calendars.length === 0 && !draft ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">No calendars yet.</p>
      ) : null}

      <ul className="space-y-2">
        {calendars.map((calendar) => (
          <li
            key={calendar.id}
            className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{calendar.name}</p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {calendar.dates.length} date entr{calendar.dates.length === 1 ? 'y' : 'ies'}:{' '}
                  {calendar.dates.slice(0, 6).map(describeEntry).join(', ')}
                  {calendar.dates.length > 6 ? ', …' : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setDraft({ id: calendar.id, name: calendar.name, dates: calendar.dates })
                  }
                  className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(calendar.id)}
                  className="text-sm text-red-600 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <label className="mb-1 block text-sm font-medium">
            Name
            <input
              className={`${inputClass} mt-1 block w-full`}
              value={draft.name}
              placeholder="e.g. US Holidays"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <p className="mb-1 mt-3 text-sm font-medium">Dates</p>
          <EntryEditor dates={draft.dates} onChange={(dates) => setDraft({ ...draft, dates })} />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || !draft.name.trim()}
              onClick={() => void save()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {draft.id ? 'Save calendar' : 'Create calendar'}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDraft({ id: null, name: '', dates: [] })}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + New calendar
        </button>
      )}

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
