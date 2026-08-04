import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createLogger } from '@campfhir/bored-logs'

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const logger = createLogger()

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
      })
      return NextResponse.next()
    }

    // Protect /mcp/* and /tenant/* routes
    const isProtected = pathname.startsWith('/mcp/') || pathname.startsWith('/tenant/')
    if (!isProtected) {
      logger.info('[proxy] Unprotected route: {method} {pathname}', {
        method: request.method,
        pathname,
        route_type: 'unprotected',
      })
      return NextResponse.next()
    }

    // Extract tenantId from path
    const pathParts = pathname.split('/').filter(Boolean)
    const tenantId = pathParts[1]

    // Check for OIDC token
    const token = request.cookies.get(`oidc_token_${tenantId}`)?.value

    if (!token) {
      logger.info('[proxy] Protected route without token: {method} {pathname} tenantId={tenantId}', {
        method: request.method,
        pathname,
        tenantId,
        route_type: 'protected',
        action: 'redirect_to_login',
      })

      const loginUrl = new URL(`/api/auth/oidc/login`, request.url)
      loginUrl.searchParams.set('tenantId', tenantId)
      loginUrl.searchParams.set('redirect', pathname + request.nextUrl.search)
      return NextResponse.redirect(loginUrl)
    }

    logger.info('[proxy] Protected route with token: {method} {pathname} tenantId={tenantId}', {
      method: request.method,
      pathname,
      tenantId,
      route_type: 'protected',
      action: 'allow',
    })
    return NextResponse.next()
  } catch (error) {
    console.error('[PROXY] Error in proxy:', error)
    return NextResponse.next()
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
