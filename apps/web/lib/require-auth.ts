/**
 * Enforces authentication before page rendering.
 *
 * Pages that require a signed-in user should call this at the start
 * before any component rendering or async data fetching. This ensures
 * the auth check happens in the function body before React component
 * evaluation, not in a server action after rendering starts.
 */

import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';

/**
 * Redirects unsigned-out users to sign in. Returns the session if present.
 * Call this at the start of a server component, before any rendering logic.
 */
export async function requireAuth(tenantId: string, returnUrl: string) {
  const session = await getSessionFromCookies(tenantId);
  if (!session) {
    redirect(signInUrl(tenantId, returnUrl));
  }
  return session;
}
