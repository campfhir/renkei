import React from 'react';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getSchedule } from '@renkei/batch-jobs-store';
import { parseScheduleConfig, type ScheduleConfig } from '@renkei/agents';
import { loadCalendarOptions } from '@/lib/schedule-calendars';
import EditScheduleForm, { type SourceValue } from './edit-schedule-form';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceValueOf(config: Record<string, unknown>): SourceValue {
  const shareId = str(config.shareId);
  const path = str(config.path) || '/';
  const grouping = isRecord(config.grouping) ? config.grouping : {};
  if (str(grouping.strategy) === 'filename-pattern') {
    return { shareId, path, strategy: 'filename-pattern', pattern: str(grouping.pattern) };
  }
  return { shareId, path, strategy: 'whole-file', pattern: '' };
}

export default async function EditBatchJobSchedulePage({
  params,
}: {
  params: Promise<{ slug: string; scheduleId: string }>;
}): Promise<React.ReactNode> {
  const { slug, scheduleId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/batch-jobs/schedules/${scheduleId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const schedule = await getSchedule(dbResult.val, scheduleId, tenant.id);
  if (!schedule || schedule.subject !== session.subject) notFound();

  const calendars = await loadCalendarOptions(dbResult.val, tenant.id);
  const fallbackScheduleConfig: ScheduleConfig = { recurrences: [{ every: 'day', at: '09:00' }], timezone: 'UTC' };
  const scheduleConfig = parseScheduleConfig(schedule.schedule_config) ?? fallbackScheduleConfig;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <BackLink href={`/${slug}/batch-jobs/schedules`} label="Schedules" />
        <h1 className="min-w-0 truncate text-xl font-bold">{schedule.name}</h1>
      </div>
      <EditScheduleForm
        slug={slug}
        tenantId={tenant.id}
        scheduleId={schedule.id}
        initialName={schedule.name}
        initialSource={sourceValueOf(schedule.config)}
        initialScheduleConfig={scheduleConfig}
        initialEnabled={schedule.enabled}
        lastError={schedule.last_error}
        calendars={calendars}
      />
    </div>
  );
}
