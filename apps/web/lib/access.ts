import { getSessionFromCookies, type Session } from '@/lib/session';

/**
 * Role-based access, from the session's roles alone.
 *
 * Roles are minted exactly once, by the OIDC callback, from the IdP's role
 * claim per the org's mapping — a user can hold several. There is no second
 * credential: the legacy operator cookie is gone, so what the IdP asserted is
 * the whole story.
 *
 * checkAccess is async on purpose, beyond the cookie read: it is the seam
 * where "trust the roles recorded at sign-in" could later become "ask the
 * IdP for current roles" without touching a single call site — callers pass
 * the roles they require and never look inside the token. Gates name their
 * requirement as an array so new roles slot in by editing one list.
 */

export const ROLE_OPERATOR = 'renkei-operator';
export const ROLE_USER = 'renkei-user';

/**
 * The caller's session when it carries at least one of the allowed roles,
 * null otherwise — callers fail closed on null (401 for routes, redirect for
 * pages).
 */
export async function checkAccess(
  tenantId: string,
  allowedRoles: readonly string[]
): Promise<Session | null> {
  const session = await getSessionFromCookies(tenantId);
  if (!session) return null;
  return allowedRoles.some((role) => session.roles.includes(role)) ? session : null;
}
