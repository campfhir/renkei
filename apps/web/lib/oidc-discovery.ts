/**
 * The OIDC discovery URL for an issuer, appended per the OpenID Connect
 * Discovery spec: `{issuer}/.well-known/openid-configuration`.
 *
 * Every call site used to build this with
 * `new URL('/.well-known/openid-configuration', issuer)` — and a leading-slash
 * path in `new URL(path, base)` REPLACES the base's path. For a path-less
 * issuer the two spellings agree, which is why this survived; for an Entra
 * issuer like `https://login.microsoftonline.com/{tenant}/v2.0` it silently
 * dropped the tenant segment, discovery answered with an empty body, and
 * sign-in limped along on hardcoded fallbacks.
 */
export function oidcDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}
