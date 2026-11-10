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
import { getSessionFromRequest } from '@/lib/session';
import { parseCoachMarkRecord } from '@/lib/coach-marks/progress';
import { listCoachMarkProgress, recordCoachMarkEvent } from '@/lib/coach-marks/store';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const progress = await listCoachMarkProgress(session.subject);
  return NextResponse.json({ progress });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const record = parseCoachMarkRecord(body);
  if (!record) {
    return NextResponse.json({ error: 'Expected a tour, an event and a step' }, { status: 400 });
  }

  const written = await recordCoachMarkEvent(session.subject, record);
  if (!written.ok) {
    logger.error(
      '{actor} reported the "{tour}" tour as {event} at step {step}, but the progress was not recorded; the tour may show again: {error}',
      {
        component: 'api/coach-marks',
        ...who(session),
        tour: record.tourId,
        event: record.event,
        step: record.step,
        error: written.err.message ?? written.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not record' }, { status: 500 });
  }
  return NextResponse.json({ progress: written.val });
}
