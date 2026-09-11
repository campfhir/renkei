/**
 * One person's own preferences. Strictly their own: the subject comes from
 * the session and never from the request, so there is no shape of body that
 * edits somebody else's settings.
 *
 * `notifications` and `theme` are independent documents, each a whole-
 * document replace when its key is present in the body — which is what each
 * of the two forms on the preferences page sends. Unknown connector and
 * category keys are DROPPED rather than rejected: during a rolling deploy
 * an older page can post a grid that no longer matches the catalog, and
 * refusing the save would strand somebody on a page that cannot be used
 * until the deploy finishes.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getNotificationPrefs,
  getThemePrefs,
  parseNotificationPrefs,
  parseThemePrefs,
  setNotificationPrefs,
  setThemePrefs,
} from '@renkei/user-prefs';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const [notifications, theme] = await Promise.all([
    getNotificationPrefs(tenantId, session.subject, { fresh: true }),
    getThemePrefs(tenantId, session.subject, { fresh: true }),
  ]);
  return NextResponse.json({ notifications, theme });
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
  const payload: { notifications?: unknown; theme?: unknown } = body;

  // Each of the two is only written when the caller actually sent that key —
  // the notification form PUTs just `{notifications}` and the appearance
  // form PUTs just `{theme}`, and writing the other's default over an unsent
  // key would silently reset whichever preference the caller wasn't editing.
  //
  // The parser is the validator for the one that IS sent: it keeps what it
  // recognises and fills the rest from the defaults, so a partial or stale
  // document is usable rather than a 400.
  let notifications = await getNotificationPrefs(tenantId, session.subject, { fresh: true });
  if ('notifications' in payload) {
    notifications = parseNotificationPrefs(payload.notifications);
    const written = await setNotificationPrefs(tenantId, session.subject, notifications);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  let theme = await getThemePrefs(tenantId, session.subject, { fresh: true });
  if ('theme' in payload) {
    theme = parseThemePrefs(payload.theme);
    const written = await setThemePrefs(tenantId, session.subject, theme);
    if (!written.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }

  return NextResponse.json({ notifications, theme });
}
