/**
 * Where a signed-out browser goes to authenticate.
 *
 * Always this endpoint, never `/`. The home-realm page at `/` starts no flow,
 * and only this route clears a stale session cookie and records where to return
 * to — so linking anywhere else leaves a browser that holds a dead cookie
 * bouncing between "sign in" prompts without ever reaching an identity
 * provider.
 */
export function signInUrl(tenantId: string, redirectTo?: string): string {
  const params = new URLSearchParams({ tenantId });
  if (redirectTo) params.set('redirect', redirectTo);
  return `/api/auth/oidc/login?${params.toString()}`;
}
