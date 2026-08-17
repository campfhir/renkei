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
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseCalendarPayload } from '@/lib/agents/calendar-payload';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const rows = await dbResult.val
    .selectFrom('schedule_calendars')
    .select(['id', 'name', 'dates', 'updated_at'])
    .where('tenant_id', '=', tenant.id)
    .orderBy('name')
    .execute();

  return NextResponse.json({
    calendars: rows.map((row) => ({
      id: row.id,
      name: row.name,
      dates: Array.isArray(row.dates) ? row.dates : [],
      updatedAt: row.updated_at,
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
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

  const id = randomUUID();
  try {
    await dbResult.val
      .insertInto('schedule_calendars')
      .values({
        id,
        tenant_id: tenant.id,
        name: parsed.name,
        dates: JSON.stringify(parsed.dates),
      })
      .execute();
  } catch (error) {
    if (error instanceof Error && error.message.includes('idx_schedule_calendars_tenant_name')) {
      return NextResponse.json({ error: 'A calendar with that name exists' }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ id }, { status: 201 });
}
