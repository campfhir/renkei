import { NextRequest, NextResponse } from 'next/server';
import { destroySession, getSessionFromRequest, sessionCookieName } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';

/**
 * End the caller's session for the tenant the body names: the session row is
 * destroyed and its cookie expired. The session id comes from the cookie,
 * never the body, so a caller can only sign out the browser making the
 * request.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const tenantId =
    typeof body === 'object' && body !== null && 'tenantId' in body
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (body as Record<string, unknown>).tenantId
      : undefined;

  const response = NextResponse.json({ success: true });
  if (typeof tenantId === 'string' && tenantId) {
    const cookieName = sessionCookieName(tenantId);
    const sessionId = request.cookies.get(cookieName)?.value;
    if (sessionId) {
      // Resolve who this was BEFORE the session dies — afterwards the id
      // resolves to nobody and the sign-out would be unattributable.
      const session = await getSessionFromRequest(request, tenantId);
      await destroySession(sessionId);
      if (session) {
        recordAuditEvent({ tenantId, actorSubject: session.subject, action: 'user.signed_out' });
      }
    }
    response.cookies.delete(cookieName);
  }
  return response;
}
