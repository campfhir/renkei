/**
 * "I am on this page, as of now" — the heartbeat NotificationCenter sends
 * while a page is open and visible (components/notification-center.tsx).
 * Scoped to the caller's own session.subject structurally: nothing in the
 * body can record presence on behalf of anyone else.
 *
 * Best-effort like the rest of the notification pipeline — a dropped ping
 * costs a missed suppression, never a wrong one, since the reply
 * notification path defaults to sending when it has nothing recent to
 * check against.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { pingPresence } from '@renkei/notifications';
import { getSessionFromRequest } from '@/lib/session';

/** Same-origin relative paths only — this records where in Renkei someone
 *  is, never an arbitrary string a script could stuff the table with. */
const MAX_PATH_LENGTH = 512;

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
  const { path } = body as { path?: unknown };
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.length > MAX_PATH_LENGTH
  ) {
    return NextResponse.json({ error: 'Expected a same-origin path' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  await pingPresence(dbResult.val, tenantId, session.subject, path);

  return NextResponse.json({ ok: true });
}
