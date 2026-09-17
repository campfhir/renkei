/**
 * requested ∩ granted, for a provider whose OAuth app fixes its scopes on
 * the consumer/client registration rather than letting the authorize step
 * narrow them (Zoom, Bitbucket) — so the token always carries the app's
 * full configured set, and only intersecting with what the user actually
 * requested preserves their narrowing.
 *
 * `granted` is trusted only when it shares at least one entry with
 * `requested`; otherwise it is in a vocabulary this app does not
 * recognize (observed for Bitbucket: `read:repository:bitbucket-legacy`
 * etc., sharing no strings with the classic scope names requested_scopes
 * stores) and intersecting against it would silently zero out every
 * tool. An unrecognized or absent granted list falls back to requested
 * alone, exactly like a token whose scopes are simply unknown.
 *
 * This is THE rule for reading a Bitbucket grant's scopes: the tool
 * registry (registry.ts) and the code-project access check
 * (lib/code/access.ts) both stand on it, so that what the tools can do
 * and what the Code page says they can do never disagree. It lives in
 * its own module because registry.ts pulls in every tool at import time,
 * which a page or a unit test has no reason to pay for.
 */
export function narrowedScopes(
  requested: string[],
  granted: string[] | null | undefined
): string[] {
  const recognized = granted && granted.some((scope) => requested.includes(scope)) ? granted : null;
  return recognized ? requested.filter((scope) => recognized.includes(scope)) : requested;
}
