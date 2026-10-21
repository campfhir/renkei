/**
 * The REST API version both Salesforce connectors are pinned to, and the
 * org host they may talk to.
 *
 * One constant, bumped deliberately after reading that release's notes —
 * never the REST `latest` alias, which would let Salesforce change the
 * contract underneath us (docs/salesforce-connectors-design.md, "One
 * package, HTTP in the web app"). v68.0 is Winter '27; the matching
 * developer guides are in docs/.
 */

export const SALESFORCE_API_VERSION = '68.0';

/** `/services/data/v68.0` + path — every data, query, search and analytics call. */
export function dataPath(path: string): string {
  return `/services/data/v${SALESFORCE_API_VERSION}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Host suffixes a Salesforce org's My Domain can end in: production and
 * every sandbox or scratch org (`acme--uat.sandbox.my.salesforce.com`) are
 * under `.my.salesforce.com`; the US government cloud's are under
 * `.my.salesforce.mil`.
 */
export const MY_DOMAIN_SUFFIXES = ['.my.salesforce.com', '.my.salesforce.mil'] as const;

export type MyDomainError = 'NOT_A_URL' | 'NOT_HTTPS' | 'NOT_MY_DOMAIN';

/**
 * Normalize what an admin pasted ("acme.my.salesforce.com",
 * "https://acme.my.salesforce.com/lightning/page/home") to the org's My
 * Domain origin. The origin is also the API host: since My Domain became
 * mandatory, a token's `instance_url` is this origin, so it is the one host
 * a token for this org may travel to.
 */
export function parseMyDomain(
  input: string
): { ok: true; origin: string; host: string } | { ok: false; error: MyDomainError } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'NOT_A_URL' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: 'NOT_A_URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'NOT_HTTPS' };
  const host = url.hostname.toLowerCase();
  const suffix = MY_DOMAIN_SUFFIXES.find((candidate) => host.endsWith(candidate));
  // A bare suffix ("my.salesforce.com") names no org.
  if (!suffix || host.length <= suffix.length || url.port) {
    return { ok: false, error: 'NOT_MY_DOMAIN' };
  }
  return { ok: true, origin: `https://${host}`, host };
}

/** Whether a token response's `instance_url` is the configured org — refused otherwise. */
export function sameOrg(instanceUrl: string, myDomainOrigin: string): boolean {
  const parsed = parseMyDomain(instanceUrl);
  return parsed.ok && parsed.origin === myDomainOrigin.toLowerCase();
}

/**
 * The org id and user id from the identity URL a token response carries
 * (`https://login.salesforce.com/id/<orgId>/<userId>`). The grant's
 * account id is `<orgId>/<userId>`: a sandbox keeps production's user ids,
 * so a user id alone would collide across orgs.
 */
export function parseIdentityUrl(identityUrl: string): { orgId: string; userId: string } | null {
  let url: URL;
  try {
    url = new URL(identityUrl);
  } catch {
    return null;
  }
  const match = /\/id\/([a-zA-Z0-9]{15,18})\/([a-zA-Z0-9]{15,18})\/?$/.exec(url.pathname);
  return match ? { orgId: match[1], userId: match[2] } : null;
}

/** `<orgId>/<userId>` — provider_grants' account id for a Salesforce grant. */
export function salesforceAccountId(orgId: string, userId: string): string {
  return `${orgId}/${userId}`;
}
