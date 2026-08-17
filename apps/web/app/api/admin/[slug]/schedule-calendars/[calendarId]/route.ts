/**
 * One holiday calendar: rename/re-date (PUT) or delete (DELETE) —
 * operator-only. Deleting a calendar never touches the triggers that
 * reference it: the sweep treats a missing calendar as "no org blackouts"
 * (with a warning), so schedules keep firing rather than breaking.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseCalendarPayload } from '@/lib/agents/calendar-payload';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; calendarId: string }> }
): Promise<NextResponse> {
  const { slug, calendarId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseCalendarPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  try {
    const updated = await dbResult.val
      .updateTable('schedule_calendars')
      .set({
        name: parsed.name,
        dates: JSON.stringify(parsed.dates),
        updated_at: sql`NOW()`,
      })
      .where('id', '=', calendarId)
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      return NextResponse.json({ error: 'Calendar not found' }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('idx_schedule_calendars_tenant_name')) {
      return NextResponse.json({ error: 'A calendar with that name exists' }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; calendarId: string }> }
): Promise<NextResponse> {
  const { slug, calendarId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const deleted = await dbResult.val
    .deleteFrom('schedule_calendars')
    .where('id', '=', calendarId)
    .where('tenant_id', '=', tenant.id)
    .executeTakeFirst();
  if (Number(deleted.numDeletedRows ?? 0) === 0) {
    return NextResponse.json({ error: 'Calendar not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
