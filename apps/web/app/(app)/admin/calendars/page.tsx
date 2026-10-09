import React from 'react';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import CalendarForms from './calendar-forms';

/**
 * Org holiday calendars (schedule_calendars): named sets of blackout
 * dates that agent schedules opt into, so "US Holidays" is entered once
 * instead of on every agent. Edits apply from each schedule's next
 * computation — a fire or a save — never retroactively to an already
 * scheduled next run.
 */
export default async function AdminCalendarsPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Holiday calendars</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Named sets of blackout dates for agent schedules. A schedule that opts into a calendar skips
        or shifts runs that land on its dates, per that schedule&apos;s own policy. Changes apply
        from each schedule&apos;s next computation, not to runs already on the clock.
      </p>
      <CalendarForms />
    </div>
  );
}
