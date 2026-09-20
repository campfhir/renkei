import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { COACH_MARK_TOURS } from '@/lib/coach-marks/tours';
import { stateLabel, type CoachMarkStateLabel } from '@/lib/coach-marks/select';
import { listCoachMarkReport } from '@/lib/coach-marks/store';
import LocalTime from '@/components/local-time';

/**
 * The operator's view of the coach marks: per tour, how many people have
 * started it and how each pass ended; then everyone who has seen any tour,
 * one column per tour, so "who never finished the welcome tour" is a
 * glance rather than a query. Names come from the identity spine, as on
 * every other admin report; a subject the spine has no row for shows as
 * the subject itself.
 */

interface TourTotals {
  viewed: number;
  completed: number;
  dismissed: number;
  inProgress: number;
}

const BADGE: Record<CoachMarkStateLabel, string> = {
  'Not started': 'text-gray-400 dark:text-gray-600',
  'In progress': 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  Completed: 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300',
  Skipped: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  Updated: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300',
};

export default async function AdminTutorialsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Unable to connect to the database. Please try again later.
        </p>
      </div>
    );
  }

  const people = await listCoachMarkReport(dbResult.val, tenant.id);

  const totals = new Map<string, TourTotals>(
    COACH_MARK_TOURS.map((tour) => [
      tour.id,
      { viewed: 0, completed: 0, dismissed: 0, inProgress: 0 },
    ])
  );
  for (const person of people) {
    for (const row of person.tours) {
      const total = totals.get(row.tourId);
      if (!total) continue;
      total.viewed += 1;
      if (row.status === 'completed') total.completed += 1;
      else if (row.status === 'dismissed') total.dismissed += 1;
      else total.inProgress += 1;
    }
  }

  const percent = (part: number, whole: number) =>
    whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Tutorials</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Who has taken the guided tours, who finished them, and who skipped. A person counts once per
        tour, by how their latest pass ended.
      </p>

      <section aria-labelledby="tours-heading" className="mb-8">
        <h2
          id="tours-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500"
        >
          By tour
        </h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800">
                <th className="px-4 py-2 font-semibold">Tour</th>
                <th className="px-4 py-2 text-right font-semibold">Viewed</th>
                <th className="px-4 py-2 text-right font-semibold">Completed</th>
                <th className="px-4 py-2 text-right font-semibold">Skipped</th>
                <th className="px-4 py-2 text-right font-semibold">In progress</th>
                <th className="px-4 py-2 text-right font-semibold">Completion</th>
              </tr>
            </thead>
            <tbody>
              {COACH_MARK_TOURS.map((tour) => {
                const total = totals.get(tour.id) ?? {
                  viewed: 0,
                  completed: 0,
                  dismissed: 0,
                  inProgress: 0,
                };
                return (
                  <tr
                    key={tour.id}
                    data-testid={`tour-totals-${tour.id}`}
                    className="border-b border-gray-100 last:border-0 dark:border-gray-900"
                  >
                    <td className="px-4 py-2">
                      <span className="font-medium">{tour.title}</span>
                      <span className="ml-2 text-xs text-gray-500">
                        v{tour.version} · {tour.steps.length}{' '}
                        {tour.steps.length === 1 ? 'step' : 'steps'}
                        {tour.audience === 'operators' ? ' · operators' : ''}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{total.viewed}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{total.completed}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{total.dismissed}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{total.inProgress}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {percent(total.completed, total.viewed)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="people-heading">
        <h2
          id="people-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500"
        >
          By person
        </h2>
        {people.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
            Nobody has seen a tour yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800">
                  <th className="px-4 py-2 font-semibold">Person</th>
                  {COACH_MARK_TOURS.map((tour) => (
                    <th key={tour.id} className="px-4 py-2 font-semibold">
                      {tour.title}
                    </th>
                  ))}
                  <th className="px-4 py-2 font-semibold">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => {
                  const bySubject = new Map(person.tours.map((row) => [row.tourId, row]));
                  const latest = person.tours
                    .map((row) => row.lastViewedAt)
                    .sort()
                    .at(-1);
                  return (
                    <tr
                      key={person.subject}
                      data-testid="tutorial-person"
                      className="border-b border-gray-100 last:border-0 dark:border-gray-900"
                    >
                      <td className="px-4 py-2">
                        <p className="font-medium">
                          {person.displayName ?? person.email ?? person.subject}
                        </p>
                        {person.email && person.displayName ? (
                          <p className="text-xs text-gray-500">{person.email}</p>
                        ) : null}
                      </td>
                      {COACH_MARK_TOURS.map((tour) => {
                        const row = bySubject.get(tour.id);
                        const label = stateLabel(row, tour);
                        return (
                          <td key={tour.id} className="px-4 py-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[label]}`}
                              title={
                                row
                                  ? `Step ${row.stepReached + 1} of ${row.stepsTotal} · viewed ${row.viewCount}×, completed ${row.completedCount}×, skipped ${row.dismissedCount}×`
                                  : undefined
                              }
                            >
                              {label}
                            </span>
                          </td>
                        );
                      })}
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {latest ? <LocalTime at={latest} /> : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
