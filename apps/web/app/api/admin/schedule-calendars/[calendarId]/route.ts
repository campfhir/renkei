/**
 * One holiday calendar: rename/re-date (PUT) or delete (DELETE) —
 * operator-only. Deleting a calendar never touches the triggers that
 * reference it: the sweep treats a missing calendar as "no org blackouts"
 * (with a warning), so schedules keep firing rather than breaking.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { parseCalendarPayload } from '@/lib/agents/calendar-payload';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ calendarId: string }> }
): Promise<NextResponse> {
  const { calendarId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseCalendarPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const updated = await getDataStore().scheduleCalendars.update(calendarId, {
    name: parsed.name,
    dates: parsed.dates,
  });
  if (updated === 'not-found') {
    return NextResponse.json({ error: 'Calendar not found' }, { status: 404 });
  }
  if (updated === 'duplicate') {
    return NextResponse.json({ error: 'A calendar with that name exists' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ calendarId: string }> }
): Promise<NextResponse> {
  const { calendarId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deleted = await getDataStore().scheduleCalendars.delete(calendarId);
  if (!deleted) {
    return NextResponse.json({ error: 'Calendar not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
