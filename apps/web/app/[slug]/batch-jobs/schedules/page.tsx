import React from 'react';
import Link from 'next/link';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listSchedules } from '@renkei/batch-jobs-store';
import LocalTime from '@/components/local-time';

/** Your recurring batch-job schedules — the agent triggers list's precedent, applied to batch jobs. */
export default async function BatchJobSchedulesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/batch-jobs/schedules`));
  }

  const dbResult = getDatabase();
  const schedules = dbResult.ok
    ? await listSchedules(dbResult.val, tenant.id, session.subject)
    : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <BackLink href={`/${slug}/batch-jobs`} label="Batch Jobs" />
          <h1 className="truncate text-xl font-bold">Schedules</h1>
        </div>
        <Link
          href={`/${slug}/batch-jobs/schedules/new`}
          className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          New schedule
        </Link>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        A schedule fires on its own recurrence and starts a fresh batch job each time, tagged with
        the schedule it came from.
      </p>

      {schedules.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No schedules yet.</p>
      ) : (
        <ul className="space-y-2">
          {schedules.map((schedule) => (
            <li key={schedule.id}>
              <Link
                href={`/${slug}/batch-jobs/schedules/${schedule.id}`}
                className="flex items-center justify-between gap-3 rounded-md border border-gray-200 p-3 text-sm hover:border-blue-400 dark:border-gray-800"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      schedule.enabled
                        ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400'
                    }`}
                  >
                    {schedule.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className="truncate">{schedule.name}</span>
                </span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {schedule.last_error ? (
                    <span className="text-red-700 dark:text-red-300">Error</span>
                  ) : schedule.enabled && schedule.next_run_at ? (
                    <>
                      Next: <LocalTime at={schedule.next_run_at} />
                    </>
                  ) : (
                    'Not scheduled'
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
