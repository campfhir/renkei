/**
 * Folder creation from the files browser — the REST twin of
 * fileshare_create_folder. The fileshare worker authorizes on the PARENT
 * folder (read/write there is what permits bringing a new child into
 * being) and performs the mkdir; this route supplies the session subject.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { clientFailure, fsMakeFolder } from '@/lib/file-shares/service-client';
import { logger } from '@/lib/logger';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ shareId: string }> }
): Promise<NextResponse> {
  const { shareId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const raw = isRecord(body) ? body.path : undefined;
  if (typeof raw !== 'string' || !raw) {
    return NextResponse.json({ error: 'Unusable path' }, { status: 400 });
  }

  const made = await fsMakeFolder({ shareId, subject: session.subject }, raw);
  if (!made.ok) {
    const failure = clientFailure(made.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn']('File share request failed ({status}): {error}', {
        component: 'api/fileshares/folders',
        subject: session.subject,
        shareId,
        operation: 'made',
        status: failure.status,
        error: 'message' in made.err && made.err.message ? made.err.message : failure.message,
      });
    }
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ ok: true, path: made.val.path });
}
