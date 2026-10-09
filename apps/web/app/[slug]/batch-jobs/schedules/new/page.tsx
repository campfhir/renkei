import React from 'react';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadCalendarOptions } from '@/lib/schedule-calendars';
import NewScheduleForm from './new-schedule-form';

export default async function NewBatchJobSchedulePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;

  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/batch-jobs/schedules/new`));
  }

  const dbResult = getDatabase();
  const calendars = dbResult.ok ? await loadCalendarOptions(dbResult.val) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <BackLink href={`/batch-jobs/schedules`} label="Schedules" />
        <h1 className="text-xl font-bold">New schedule</h1>
      </div>
      <NewScheduleForm slug={slug} calendars={calendars} />
    </div>
  );
}
