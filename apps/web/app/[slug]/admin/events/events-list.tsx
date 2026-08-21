'use client';

/**
 * The event monitor's table — a client component because every timestamp
 * renders in the VIEWER's zone (the audit page's rule), plus a status
 * filter that is pure view state.
 */

import { useMemo, useState } from 'react';
import LocalTime from '@/components/local-time';

export type EventStatus = 'queued' | 'processing' | 'processed' | 'skipped' | 'retrying' | 'failed';

export interface EventRow {
  id: string;
  source: string;
  /** The handler namespace the event was handed off to. */
  type: string;
  status: EventStatus;
  attempts: number;
  /** Owner display: email when resolvable, else the raw account hint. */
  user: string | null;
  /** ISO instant the delivery was accepted. */
  receivedAt: string;
}

const STATUS_LABEL: Record<EventStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  processed: 'Processed',
  skipped: 'Skipped',
  retrying: 'Retrying',
  failed: 'Failed',
};

const STATUS_CLASS: Record<EventStatus, string> = {
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  processing: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  processed: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  skipped: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  retrying: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

const FILTERS: readonly (EventStatus | 'all')[] = [
  'all',
  'processed',
  'skipped',
  'retrying',
  'failed',
  'queued',
];

export default function EventsList({ events }: { events: EventRow[] }): React.ReactNode {
  const [filter, setFilter] = useState<EventStatus | 'all'>('all');

  const counts = useMemo(() => {
    const byStatus = new Map<EventStatus, number>();
    for (const event of events) {
      byStatus.set(event.status, (byStatus.get(event.status) ?? 0) + 1);
    }
    return byStatus;
  }, [events]);

  const shown = filter === 'all' ? events : events.filter((event) => event.status === filter);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((option) => {
          const count = option === 'all' ? events.length : (counts.get(option) ?? 0);
          if (option !== 'all' && count === 0) return null;
          return (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                filter === option
                  ? 'border-gray-700 bg-gray-700 text-white dark:border-gray-300 dark:bg-gray-300 dark:text-gray-900'
                  : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
              }`}
            >
              {option === 'all' ? 'All' : STATUS_LABEL[option]} · {count}
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900">
            <tr>
              <th className="px-3 py-2 font-medium">Received</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Handed off to</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {shown.map((event) => (
              <tr key={event.id} className="bg-white dark:bg-gray-950">
                <td className="whitespace-nowrap px-3 py-1.5 text-gray-600 dark:text-gray-400">
                  <LocalTime at={event.receivedAt} />
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 font-medium">{event.source}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-gray-600 dark:text-gray-400">
                  {event.type}
                </td>
                <td className="max-w-56 truncate px-3 py-1.5 text-gray-600 dark:text-gray-400">
                  {event.user ?? '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[event.status]}`}
                  >
                    {STATUS_LABEL[event.status]}
                    {event.status === 'retrying' ? ` (attempt ${event.attempts})` : ''}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
