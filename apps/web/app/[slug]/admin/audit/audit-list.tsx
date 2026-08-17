'use client';

import { useEffect, useState } from 'react';
import { grantProviderLabel } from '@/lib/provider-labels';

export interface AuditEventRow {
  id: string;
  action: string;
  targetLabel: string | null;
  /** Small structured extras recorded with the event (never content). */
  details: Record<string, unknown> | null;
  /** ISO timestamp. */
  at: string;
  actor: string;
}

/** action + target → the sentence's predicate; the actor is the subject. */
function describe(event: AuditEventRow): string {
  const details = event.details ?? {};
  const byAdmin = details.byAdmin === true;
  const connector = grantProviderLabel(event.targetLabel ?? '');
  const agent = event.targetLabel ?? 'an agent';

  switch (event.action) {
    case 'user.signed_in':
      return 'signed in';
    case 'user.signed_out':
      return 'signed out';
    case 'connector.connected':
      return `connected ${connector}`;
    case 'connector.disconnected':
      return byAdmin
        ? `disconnected ${connector} for ${typeof details.account === 'string' ? details.account : 'a user'}`
        : `disconnected ${connector}`;
    case 'agent.created':
      return `created agent “${agent}”`;
    case 'agent.updated':
      return `edited agent “${agent}”`;
    case 'agent.enabled':
      return `turned on agent “${agent}”`;
    case 'agent.disabled':
      return byAdmin ? `turned off agent “${agent}” (admin action)` : `turned off agent “${agent}”`;
    case 'agent.deleted':
      return `deleted agent “${agent}”`;
    case 'settings.updated': {
      const changed =
        typeof details.changed === 'object' && details.changed !== null
          ? Object.keys(details.changed)
          : [];
      return changed.length > 0
        ? `changed organization settings: ${changed.join(', ')}`
        : 'changed organization settings';
    }
    default:
      return event.action;
  }
}

/**
 * The trail itself, client-side because DAYS are the viewer's: "Tuesday"
 * has to mean their Tuesday, and the server bucketing by its own zone put
 * late-evening events on the wrong day — the same server-clock bug as the
 * timestamps, one level up. Until mounted, events render under UTC days
 * with UTC times (deterministic, so hydration doesn't tear), then regroup
 * into the local zone.
 */
export default function AuditList({ events }: { events: AuditEventRow[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const byDay = new Map<string, AuditEventRow[]>();
  for (const event of events) {
    const date = new Date(event.at);
    const day = mounted
      ? date.toLocaleDateString(undefined, {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : `${date.toISOString().slice(0, 10)} (UTC)`;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(event);
    else byDay.set(day, [event]);
  }

  return (
    <div className="space-y-6">
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <section key={day}>
          <h2 className="mb-2 text-sm font-semibold text-gray-500">{day}</h2>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-900 dark:border-gray-800 dark:bg-gray-950">
            {dayEvents.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">{event.actor}</span> {describe(event)}
                </span>
                <time
                  dateTime={event.at}
                  title={event.at}
                  className="shrink-0 text-xs tabular-nums text-gray-500"
                >
                  {mounted
                    ? new Date(event.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : new Date(event.at).toISOString().slice(11, 16)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
