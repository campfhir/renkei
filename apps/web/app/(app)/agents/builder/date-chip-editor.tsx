'use client';

/**
 * The popover behind a date chip: click the pill, adjust what it means.
 *
 * It shows what the chip resolves to RIGHT NOW as you edit — "→
 * 2026-08-25T02:00:00.000Z" — because the entire promise of a date chip is
 * that the value is not a guess, and the only way to keep that promise
 * honest in the builder is to show the answer while the question is being
 * asked. A preview also makes the two things people get wrong visible
 * immediately: which timezone, and whether a shift means calendar days or
 * elapsed hours.
 */

import { useEffect, useRef, useState } from 'react';
import { renderDateSegment, type DateSegment } from '@renkei/agents';
import { useDismiss } from '@/lib/use-dismiss';
import { useNumericInput } from '@/lib/use-numeric-input';

const UNITS: DateSegment['unit'][] = ['minute', 'hour', 'day', 'week', 'month', 'year'];

const inputClass =
  'w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950';
const labelClass = 'block text-[0.65rem] font-medium uppercase tracking-wide text-gray-500';

export function DateChipEditor({
  segment,
  top,
  left,
  onChange,
  onClose,
}: {
  segment: DateSegment;
  /**
   * VIEWPORT coordinates, not offsets in the editor. The editor lives
   * inside the rail's scrolling panel, which clips absolutely positioned
   * children — the first version of this lost its preview and its Done
   * button below the fold. Fixed positioning escapes the scroll container.
   */
  top: number;
  left: number;
  onChange: (next: DateSegment) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onClose);
  // Re-previewed on every edit; a chip that reads "in 2 weeks" should show
  // a date two weeks out, not a stale one from when the popover opened.
  const [now] = useState(() => new Date());

  useEffect(() => {
    // Focus the amount first: it is what people come here to change.
    ref.current?.querySelector('input')?.focus();
  }, []);

  const patch = (next: Partial<DateSegment>) => onChange({ ...segment, ...next });
  // "-3" starts as "-", which is not a number yet — so the offset is typed as
  // text and committed when it parses. Left empty, it falls back rather than
  // writing NaN into the chip.
  const amountField = useNumericInput(segment.amount, (amount) => patch({ amount }));
  const preview = renderDateSegment(segment, now);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Edit date"
      style={{ top, left }}
      className="fixed z-30 w-72 rounded-md border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass} htmlFor="date-chip-amount">
            How far
          </label>
          <input
            id="date-chip-amount"
            type="number"
            className={inputClass}
            {...amountField}
            onChange={(event) => amountField.onChange(event.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="date-chip-unit">
            Unit
          </label>
          <select
            id="date-chip-unit"
            className={inputClass}
            value={segment.unit}
            onChange={(event) => {
              const unit = UNITS.find((known) => known === event.target.value) ?? 'day';
              patch({ unit });
            }}
          >
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="mt-1 text-[0.65rem] text-gray-500 dark:text-gray-400">
        Negative is in the past. Minutes and hours are exact elapsed time; days and larger keep the
        same clock time across daylight saving.
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass} htmlFor="date-chip-time">
            At time (optional)
          </label>
          <input
            id="date-chip-time"
            className={inputClass}
            placeholder="19:00"
            value={segment.atTime ?? ''}
            onChange={(event) => {
              const value = event.target.value.trim();
              const next = { ...segment };
              if (value) next.atTime = value;
              else delete next.atTime;
              onChange(next);
            }}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="date-chip-boundary">
            Or snap to
          </label>
          <select
            id="date-chip-boundary"
            className={inputClass}
            // A time of day and a boundary are mutually exclusive; the time
            // wins, so say so rather than letting a dead control mislead.
            disabled={Boolean(segment.atTime)}
            value={segment.boundary ?? ''}
            onChange={(event) => {
              const next = { ...segment };
              if (event.target.value === 'start') next.boundary = 'start';
              else if (event.target.value === 'end') next.boundary = 'end';
              else delete next.boundary;
              onChange(next);
            }}
          >
            <option value="">—</option>
            <option value="start">start of it</option>
            <option value="end">end of it</option>
          </select>
        </div>
      </div>

      <div className="mt-2">
        <label className={labelClass} htmlFor="date-chip-timezone">
          Timezone
        </label>
        <input
          id="date-chip-timezone"
          className={inputClass}
          value={segment.timezone}
          onChange={(event) => patch({ timezone: event.target.value.trim() })}
        />
      </div>

      <div className="mt-2">
        <label className={labelClass} htmlFor="date-chip-format">
          Reads as
        </label>
        <select
          id="date-chip-format"
          className={inputClass}
          value={segment.format ?? 'iso'}
          onChange={(event) => {
            const value = event.target.value;
            patch({
              format: value === 'date' ? 'date' : value === 'datetime' ? 'datetime' : 'iso',
            });
          }}
        >
          <option value="iso">Exact instant — for searches and filters</option>
          <option value="date">Just the date — for day-based queries</option>
          <option value="datetime">Local date and time — for text people read</option>
        </select>
      </div>

      <p
        aria-live="polite"
        className="mt-2 break-all rounded bg-gray-50 px-2 py-1 font-mono text-[0.7rem] text-gray-700 dark:bg-gray-950 dark:text-gray-300"
      >
        → {preview}
      </p>

      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white"
        >
          Done
        </button>
      </div>
    </div>
  );
}
