/**
 * Where the coach-mark engine reports a tour's turns: started, a step
 * reached, finished, skipped. One person's own rows, strictly: the subject
 * comes from the session and never from the body, so no shape of request
 * records a tour against somebody else.
 *
 * The body is validated against the tour registry (progress.ts) — a tour
 * that does not exist, or a step a tour never had, is a 400 rather than a
 * row — and the reducer decides what the row becomes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { parseCoachMarkRecord } from '@/lib/coach-marks/progress';
import { listCoachMarkProgress, recordCoachMarkEvent } from '@/lib/coach-marks/store';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });

  const progress = await listCoachMarkProgress(dbResult.val, tenantId, session.subject);
  return NextResponse.json({ progress });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const record = parseCoachMarkRecord(body);
  if (!record) {
    return NextResponse.json({ error: 'Expected a tour, an event and a step' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });

  const written = await recordCoachMarkEvent(dbResult.val, tenantId, session.subject, record);
  if (!written.ok) return NextResponse.json({ error: 'Could not record' }, { status: 500 });
  return NextResponse.json({ progress: written.val });
}
