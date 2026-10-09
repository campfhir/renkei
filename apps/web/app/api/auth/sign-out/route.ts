import { NextRequest, NextResponse } from 'next/server';
import { destroySession, getSessionFromRequest, sessionCookieName } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';

/**
 * End the caller's session: the session row is destroyed and its cookie
 * expired. The session id comes from the cookie, never the body, so a caller
 * can only sign out the browser making the request.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ success: true });
  const cookieName = sessionCookieName();
  const sessionId = request.cookies.get(cookieName)?.value;
  if (sessionId) {
    // Resolve who this was BEFORE the session dies — afterwards the id
    // resolves to nobody and the sign-out would be unattributable.
    const session = await getSessionFromRequest(request);
    await destroySession(sessionId);
    if (session) {
      recordAuditEvent({ actorSubject: session.subject, action: 'user.signed_out' });
    }
  }
  response.cookies.delete(cookieName);
  return response;
}
