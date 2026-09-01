import React from 'react';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
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
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/batch-jobs/schedules/new`));
  }

  const dbResult = getDatabase();
  const calendars = dbResult.ok ? await loadCalendarOptions(dbResult.val, tenant.id) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <BackLink href={`/${slug}/batch-jobs/schedules`} label="Schedules" />
        <h1 className="text-xl font-bold">New schedule</h1>
      </div>
      <NewScheduleForm slug={slug} tenantId={tenant.id} calendars={calendars} />
    </div>
  );
}
