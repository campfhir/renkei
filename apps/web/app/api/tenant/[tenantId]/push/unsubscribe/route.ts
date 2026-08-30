/**
 * Drops one device's push subscription — called when the switch in
 * Preferences goes off, or when the browser's own unsubscribe succeeds.
 * Deleting by (tenant, subject, endpoint) is structural scoping, same as
 * every other tenant route: a borrowed endpoint deletes nothing that isn't
 * the caller's own.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { deleteSubscription } from '@renkei/notifications';
import { getSessionFromRequest } from '@/lib/session';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  }
  const payload: { endpoint?: unknown } = body;
  if (typeof payload.endpoint !== 'string' || !payload.endpoint) {
    return NextResponse.json({ error: 'Expected a string endpoint' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  await deleteSubscription(dbResult.val, tenantId, session.subject, payload.endpoint);

  return NextResponse.json({ ok: true });
}
