/**
 * Batch-job schedules — the recurring recipe a batch is defined once
 * against (packages/batch-jobs-store/src/schedules.ts). Only
 * document-ocr-pipeline exists today, so this hardcodes `kind` the same
 * way the one-off /batch-jobs start route does; a future batch kind adds
 * a `kind` field here the same way it would add one there.
 *
 * Session-scoped like the one-off start route (not operator-only like
 * schedule_calendars) — a schedule is owned by whoever created it, same as
 * a batch job itself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { listConnectedShares } from '@renkei/connector-fileshares';
import { createSchedule, listSchedules, DOCUMENT_OCR_PIPELINE_KIND } from '@renkei/batch-jobs-store';
import { parseScheduleConfig } from '@renkei/agents';
import { parseGrouping } from '@/lib/batch-jobs/grouping';
import {
  AFTER_PROCESSING_SHAPE,
  afterProcessingRefusal,
  parseAfterProcessing,
  parseSkipProcessed,
} from '@/lib/batch-jobs/pipeline-options';
import { documentPipelineConfig } from '@/lib/batch-jobs/start-document-ocr-pipeline';
import { nextRunAtFor } from '@/lib/batch-jobs/schedule-next-run';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const schedules = await listSchedules(dbResult.val, tenantId, session.subject);
  return NextResponse.json({
    schedules: schedules.map((schedule) => ({
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
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

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

  const skipProcessed = parseSkipProcessed(body.skipProcessed);
  if (skipProcessed === null) {
    return NextResponse.json({ error: 'skipProcessed must be a boolean' }, { status: 400 });
  }
  const afterProcessing = parseAfterProcessing(body.afterProcessing);
  if (!afterProcessing) return NextResponse.json({ error: AFTER_PROCESSING_SHAPE }, { status: 400 });

  const scheduleConfig = parseScheduleConfig(body.scheduleConfig);
  if (!scheduleConfig) {
    return NextResponse.json({ error: 'scheduleConfig is missing or malformed' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // The share must exist and this caller must have connected their own
  // credentials to it, and moving/deleting there must be within what they
  // allowed on the Connectors page — same check the one-off start route makes.
  const shares = await listConnectedShares(dbResult.val, tenantId, session.subject);
  if (!shares.ok) return NextResponse.json({ error: 'Could not read your file shares' }, { status: 500 });
  const refusal = afterProcessingRefusal(shares.val, shareId, afterProcessing);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  let nextRunAt: Date;
  try {
    nextRunAt = await nextRunAtFor(dbResult.val, tenantId, scheduleConfig);
  } catch {
    return NextResponse.json(
      { error: 'No next occurrence could be found for that schedule (check blackout dates).' },
      { status: 400 }
    );
  }

  // ScheduleConfig is a plain JSON-safe object; the store stays
  // dependency-light (no @renkei/agents import) so it types this as
  // Record<string, unknown> rather than the concrete shape.
  const scheduleConfigRecord: Record<string, unknown> = { ...scheduleConfig };

  try {
    const schedule = await createSchedule(dbResult.val, {
      tenantId,
      subject: session.subject,
      name,
      kind: DOCUMENT_OCR_PIPELINE_KIND,
      config: { ...documentPipelineConfig({ shareId, path, grouping, skipProcessed, afterProcessing }) },
      scheduleConfig: scheduleConfigRecord,
      nextRunAt,
    });
    return NextResponse.json({ id: schedule.id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('batch_job_schedules_tenant_name')) {
      return NextResponse.json({ error: 'A schedule with that name already exists' }, { status: 409 });
    }
    throw error;
  }
}
