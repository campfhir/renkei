import { NextRequest, NextResponse } from 'next/server';
import { destroySession, sessionCookieName } from '@/lib/session';

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
    if (sessionId) await destroySession(sessionId);
    response.cookies.delete(cookieName);
  }
  return response;
}
