import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Skip logging health checks
  if (pathname !== '/api/health') {
    // Log all incoming requests
    logger.info('[proxy] Incoming request: {method} {pathname}', {
      method: request.method,
      pathname,
      url: request.nextUrl.toString(),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      origin: request.headers.get('origin'),
      contentType: request.headers.get('content-type'),
      query: request.nextUrl.search,
      ip: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip'),
      timestamp: new Date().toISOString(),
    });
  }

  try {
    // Allow public routes: API, static pages, etc.
    if (
      pathname.startsWith('/api/') ||
      pathname.startsWith('/create-organization') ||
      pathname === '/' ||
      pathname.startsWith('/_next/') ||
      pathname.startsWith('/public/')
    ) {
      logger.info('[proxy] Public route: {method} {pathname}', {
        method: request.method,
        pathname,
        route_type: 'public',
      });
      return NextResponse.next();
    }

    // Protect /mcp/* and /tenant/* routes
    const isProtected = pathname.startsWith('/mcp/') || pathname.startsWith('/tenant/');
    if (!isProtected) {
      logger.info('[proxy] Unprotected route: {method} {pathname}', {
        method: request.method,
        pathname,
        route_type: 'unprotected',
      });
      return NextResponse.next();
    }

    // Extract tenantId from path
    const pathParts = pathname.split('/').filter(Boolean);
    const tenantId = pathParts[1];

    // Presence check only — this runs before the database is reachable, so it
    // cannot validate the session. It exists to redirect signed-out users to
    // login; actual authorization happens in the page/route via getSession*.
    const token = request.cookies.get(`renkei_session_${tenantId}`)?.value;

    if (!token) {
      logger.info(
        '[proxy] Protected route without token: {method} {pathname} tenantId={tenantId}',
        {
          method: request.method,
          pathname,
          tenantId,
          route_type: 'protected',
          action: 'redirect_to_login',
        }
      );

      const loginUrl = new URL(`/api/auth/oidc/login`, request.url);
      loginUrl.searchParams.set('tenantId', tenantId);
      loginUrl.searchParams.set('redirect', pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }

    logger.info('[proxy] Protected route with token: {method} {pathname} tenantId={tenantId}', {
      method: request.method,
      pathname,
      tenantId,
      route_type: 'protected',
      action: 'allow',
    });
    return NextResponse.next();
  } catch (error) {
    logger.error('[proxy] Error in proxy: {error}', {
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
