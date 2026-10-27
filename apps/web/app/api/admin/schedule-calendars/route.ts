/**
 * Org holiday calendars (schedule_calendars) — operator-only.
 *
 * A calendar is a name plus a BlackoutEntry[] of dates; agent schedule
 * triggers opt into one by id. Edits apply from each schedule's NEXT
 * computation (fire or save) — stored next_run_at values are not
 * retro-adjusted, and the admin page says so.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { parseCalendarPayload } from '@/lib/agents/calendar-payload';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await getDataStore().scheduleCalendars.list();

  return NextResponse.json({
    calendars: rows.map((row) => ({
      id: row.id,
      name: row.name,
      dates: Array.isArray(row.dates) ? row.dates : [],
      updatedAt: row.updatedAt,
    })),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseCalendarPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const id = randomUUID();
  const created = await getDataStore().scheduleCalendars.create({
    id,
    name: parsed.name,
    dates: parsed.dates,
  });
  if (created === 'duplicate') {
    return NextResponse.json({ error: 'A calendar with that name exists' }, { status: 409 });
  }
  return NextResponse.json({ id }, { status: 201 });
}
