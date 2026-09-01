/**
 * One batch-job schedule: read, edit (name/source folder/recurrence/enabled),
 * or delete — session-scoped like the collection route (batch-job-schedules/route.ts).
 *
 * next_run_at is recomputed server-side whenever the recurrence changes or a
 * disabled schedule is re-enabled — the client only ever sends a
 * ScheduleConfig, never a timestamp.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { listConnectedShares } from '@renkei/connector-fileshares';
import { getSchedule, updateSchedule, deleteSchedule, type UpdateScheduleInput } from '@renkei/batch-jobs-store';
import { parseScheduleConfig, type ScheduleConfig } from '@renkei/agents';
import { parseGrouping } from '@/lib/batch-jobs/grouping';
import { nextRunAtFor } from '@/lib/batch-jobs/schedule-next-run';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; scheduleId: string }> }
): Promise<NextResponse> {
  const { tenantId, scheduleId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const schedule = await getSchedule(dbResult.val, scheduleId, tenantId);
  if (!schedule || schedule.subject !== session.subject) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  return NextResponse.json({
    id: schedule.id,
    name: schedule.name,
    kind: schedule.kind,
    config: schedule.config,
    scheduleConfig: schedule.schedule_config,
    enabled: schedule.enabled,
    nextRunAt: schedule.next_run_at,
    lastFiredAt: schedule.last_fired_at,
    lastError: schedule.last_error,
    createdAt: schedule.created_at,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; scheduleId: string }> }
): Promise<NextResponse> {
  const { tenantId, scheduleId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const existing = await getSchedule(dbResult.val, scheduleId, tenantId);
  if (!existing || existing.subject !== session.subject) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }

  const updates: UpdateScheduleInput = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
    updates.name = name;
  }

  const changingConfig = body.shareId !== undefined || body.path !== undefined || body.grouping !== undefined;
  if (changingConfig) {
    const shareId = typeof body.shareId === 'string' ? body.shareId : '';
    if (!shareId) return NextResponse.json({ error: 'shareId is required' }, { status: 400 });
    const path = typeof body.path === 'string' && body.path ? body.path : '/';
    const grouping = parseGrouping(body.grouping);
    if (!grouping) {
      return NextResponse.json(
        {
          error:
            'grouping must be {strategy:"whole-file"} or {strategy:"filename-pattern", pattern} ' +
            'with named captures ?<documentKey> and ?<page>',
        },
        { status: 400 }
      );
    }
    const shares = await listConnectedShares(dbResult.val, tenantId, session.subject);
    if (!shares.ok) return NextResponse.json({ error: 'Could not read your file shares' }, { status: 500 });
    if (!shares.val.some((entry) => entry.share.id === shareId)) {
      return NextResponse.json(
        { error: 'Unknown file share, or you have not connected it yet' },
        { status: 400 }
      );
    }
    updates.config = { shareId, path, grouping };
  }

  let newScheduleConfig: ScheduleConfig | undefined;
  if (body.scheduleConfig !== undefined) {
    const parsed = parseScheduleConfig(body.scheduleConfig);
    if (!parsed) return NextResponse.json({ error: 'scheduleConfig is malformed' }, { status: 400 });
    newScheduleConfig = parsed;
    // See the collection route's own comment: the store stays
    // dependency-light and just wants a JSON-safe Record.
    const parsedRecord: Record<string, unknown> = { ...parsed };
    updates.scheduleConfig = parsedRecord;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }
    updates.enabled = body.enabled;
  }

  // Recompute next_run_at whenever the recurrence changed, or a disabled
  // schedule is being re-enabled (its stored next_run_at may be stale).
  const reEnabling = updates.enabled === true && !existing.enabled;
  if (newScheduleConfig || reEnabling) {
    const effectiveConfig = newScheduleConfig ?? parseScheduleConfig(existing.schedule_config);
    if (!effectiveConfig) {
      return NextResponse.json({ error: 'The stored schedule is malformed; set scheduleConfig to fix it' }, { status: 400 });
    }
    try {
      updates.nextRunAt = await nextRunAtFor(dbResult.val, tenantId, effectiveConfig);
    } catch {
      return NextResponse.json(
        { error: 'No next occurrence could be found for that schedule (check blackout dates).' },
        { status: 400 }
      );
    }
  }

  try {
    const updated = await updateSchedule(dbResult.val, scheduleId, tenantId, updates);
    if (!updated) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes('batch_job_schedules_tenant_name')) {
      return NextResponse.json({ error: 'A schedule with that name already exists' }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; scheduleId: string }> }
): Promise<NextResponse> {
  const { tenantId, scheduleId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const existing = await getSchedule(dbResult.val, scheduleId, tenantId);
  if (!existing || existing.subject !== session.subject) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  await deleteSchedule(dbResult.val, scheduleId, tenantId);
  return NextResponse.json({ ok: true });
}
