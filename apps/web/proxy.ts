import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { PATHNAME_HEADER } from '@/lib/return-path';
import { hasMalformedUuidSegment } from '@/lib/uuid';

/**
 * Health checks, Next internals, and log shipping never log: the health probe
 * arrives every ~30 seconds forever, and every shipped batch hitting
 * /api/logs would add a proxy row about the act of delivering log rows —
 * a log stream that is mostly heartbeat is a log stream nobody reads.
 */
function isNoiseRoute(pathname: string): boolean {
  return (
    pathname === '/api/health' || pathname.startsWith('/api/logs') || pathname.startsWith('/_next/')
  );
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  try {
    // No auth gate lives here. The page tree is keyed by slug, and a slug
    // cannot be resolved to the tenant id that names the session cookie
    // without the database, which the proxy runs before. The tenant layout
    // makes that decision instead, before any HTML streams, and every
    // /[slug] page guards itself again for the navigations a layout never
    // sees. One request, one log line.
    if (!isNoiseRoute(pathname)) {
      logger.verbose('{method} {pathname}', {
        component: 'web/proxy',
        method: request.method,
        pathname,
        query: request.nextUrl.search || undefined,
        userAgent: request.headers.get('user-agent') ?? undefined,
        referer: request.headers.get('referer') ?? undefined,
        // Client address as claimed by the reverse proxy's headers — for
        // observability only, never a trust decision.
        ip: request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? undefined,
      });
    }
    // A uuid-keyed API path with a malformed id — usually a pasted URL that
    // picked up trailing punctuation from an autolinker. Postgres would
    // answer the cast with a 22P02 and the route would 500; it is a 404.
    if (hasMalformedUuidSegment(pathname)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    // The layout that gates signed-out visitors needs to know where they
    // were going, and a layout is never told. Path and query ride along on
    // a request header; the layout treats it as the sign-in return URL
    // (lib/return-path.ts). Always set, never merged: a header the client
    // sent under this name is overwritten, not honoured.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(PATHNAME_HEADER, `${pathname}${request.nextUrl.search}`);
    return NextResponse.next({ request: { headers: requestHeaders } });
  } catch (error) {
    logger.error('Proxy error: {error}', {
      component: 'web/proxy',
      error: error instanceof Error ? error.message : String(error),
      method: request.method,
      pathname,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.next();
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
