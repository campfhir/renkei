/**
 * One person's own preferences. Strictly their own: the subject comes from
 * the session and never from the request, so there is no shape of body that
 * edits somebody else's settings.
 *
 * The PUT is a whole-document replace, which is what the page sends. Unknown
 * connector and category keys are DROPPED rather than rejected: during a
 * rolling deploy an older page can post a grid that no longer matches the
 * catalog, and refusing the save would strand somebody on a page that
 * cannot be used until the deploy finishes.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getNotificationPrefs,
  parseNotificationPrefs,
  setNotificationPrefs,
} from '@renkei/user-prefs';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  return NextResponse.json({
    notifications: await getNotificationPrefs(tenantId, session.subject, { fresh: true }),
  });
}

export async function PUT(
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
  const payload: { notifications?: unknown } = body;

  // The parser is the validator: it keeps what it recognises and fills the
  // rest from the defaults, so a partial or stale document is usable rather
  // than a 400.
  const prefs = parseNotificationPrefs(payload.notifications);
  const written = await setNotificationPrefs(tenantId, session.subject, prefs);
  if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });

  return NextResponse.json({ notifications: prefs });
}
