import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Define which routes require authentication
const protectedRoutes = ['/admin'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if route requires auth
  const requiresAuth = protectedRoutes.some((route) => pathname.startsWith(route));

  if (requiresAuth) {
    const operatorSession = request.cookies.get('renkei_operator')?.value;

    if (!operatorSession) {
      // For now, just pass through and let the page handle showing the sign-in form
      // TODO: Implement OAuth sign-in flow redirect
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
