import { NextRequest, NextResponse } from 'next/server';
import { clearOperatorCookie } from '@/lib/auth-utils';
import { destroySession, sessionCookieName } from '@/lib/session';

/**
 * End the caller's sessions. Clears the operator cookie always, and — when the
 * body names a tenant — destroys that tenant's user session row and expires
 * its cookie. The session id comes from the cookie, never the body, so a
 * caller can only sign out the browser making the request.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  await clearOperatorCookie();

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
    if (sessionId) await destroySession(sessionId);
    response.cookies.delete(cookieName);
  }
  return response;
}
