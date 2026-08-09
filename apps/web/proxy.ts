import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';

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
    // No auth gate lives here anymore. The page tree is keyed by slug, and a
    // slug cannot be resolved to the tenant id that names the session cookie
    // without the database, which the proxy runs before. Every /[slug] page
    // resolves the tenant and guards itself, redirecting signed-out visitors
    // into the OIDC flow via signInUrl. One request, one log line.
    if (!isNoiseRoute(pathname)) {
      logger.info('{method} {pathname}', {
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
    return NextResponse.next();
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
