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
    // No auth gate lives here anymore. The page tree is keyed by slug, and a
    // slug cannot be resolved to the tenant id that names the session cookie
    // without the database, which the proxy runs before. Every /[slug] page
    // resolves the tenant and guards itself, redirecting signed-out visitors
    // into the OIDC flow via signInUrl — which is also where the old /mcp and
    // /tenant paths ended up after this check let them through.
    logger.info('[proxy] Route: {method} {pathname}', {
      method: request.method,
      pathname,
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
