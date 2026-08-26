/**
 * Folder creation from the files browser — the REST twin of
 * fileshare_create_folder. The fileshare worker authorizes on the PARENT
 * folder (read/write there is what permits bringing a new child into
 * being) and performs the mkdir; this route supplies the session subject.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { clientFailure, fsMakeFolder } from '@/lib/file-shares/service-client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const raw = isRecord(body) ? body.path : undefined;
  if (typeof raw !== 'string' || !raw) {
    return NextResponse.json({ error: 'Unusable path' }, { status: 400 });
  }

  const made = await fsMakeFolder({ tenantId, shareId, subject: session.subject }, raw);
  if (!made.ok) {
    const failure = clientFailure(made.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ ok: true, path: made.val.path });
}
