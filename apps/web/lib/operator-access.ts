import { getOperatorSession } from '@/lib/auth-utils';
import { getSessionFromCookies } from '@/lib/session';

export interface OperatorAccess {
  subject: string;
  /** Which credential granted access — useful in audit trails. */
  via: 'operator-cookie' | 'user-role';
}

/**
 * Whether this browser may operate the tenant's admin console.
 *
 * Two credentials qualify: the legacy signed operator cookie, and — the path
 * that actually happens — a tenant session whose roles include
 * renkei-operator, minted by the OIDC callback from the org's role-claim
 * mapping. The admin pages used to check only the cookie, and nothing ever
 * set it (setOperatorCookie had no callers), so operators signed in
 * successfully and were then asked to sign in again, forever.
 *
 * Both checks are scoped to the tenant: an operator cookie for one tenant
 * says nothing about another, and the session cookie is per-tenant already.
 */
export async function getOperatorAccess(tenantId: string): Promise<OperatorAccess | null> {
  const operator = await getOperatorSession();
  if (operator && operator.tenantId === tenantId) {
    return { subject: operator.subject, via: 'operator-cookie' };
  }

  const session = await getSessionFromCookies(tenantId);
  if (session && session.roles.includes('renkei-operator')) {
    return { subject: session.subject, via: 'user-role' };
  }

  return null;
}
