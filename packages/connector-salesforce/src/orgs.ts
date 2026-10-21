/**
 * Salesforce connectors: an organization adds one per Salesforce org it
 * works in — its production org, and each sandbox — all of the same type.
 * Each is self-contained: its own My Domain (so its own host and token
 * endpoint), its own External Client App (consumer key here, secret under
 * `clientSecret:<key>`), its own on/off switch and its own capability
 * ceiling, and each person connects each one separately. Nothing is
 * inherited from another org's connector: a sandbox's app is a different
 * app from production's.
 *
 * They are kept as a list in one connector config's `settings.orgs`, read
 * the same way by the web app and the delegate. A token minted in one org
 * travels to that org's host alone; a grant is keyed `<orgId>/<userId>`
 * (a sandbox keeps production's user ids) and records which connector it
 * belongs to.
 */

import { parseMyDomain } from './api';
import { policyFromSettings, validatePolicy, type DataPolicy } from './policy';

export interface SalesforceOrg {
  /** Stable key, unique among the connectors: what tools, grants and URLs name. */
  key: string;
  name: string;
  /** `https://<domain>.my.salesforce.com`. */
  myDomain: string;
  host: string;
  sandbox: boolean;
  enabled: boolean;
  /** This connector's consumer key (its own External Client App). */
  clientId: string;
  /** Renkei's capability ceiling for this connector — a person can narrow it, never widen it. */
  scopes: string[];
  /** What this connector keeps away from the model (policy.ts). */
  policy: DataPolicy;
}

export const MAX_ORGS = 20;

/** A key from a name: lower-case letters, digits and dashes. */
export function orgKeyOf(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org'
  );
}

/** The secret name a connector's consumer secret is stored under. */
export function orgSecretName(key: string): string {
  return `clientSecret:${key}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Every saved connector, defensively; bad entries are skipped. */
export function orgsFromSettings(settings: unknown): SalesforceOrg[] {
  const listed = record(settings).orgs;
  const orgs: SalesforceOrg[] = [];
  for (const entry of Array.isArray(listed) ? listed : []) {
    const org = record(entry);
    const domain = parseMyDomain(typeof org.myDomain === 'string' ? org.myDomain : '');
    const key = typeof org.key === 'string' ? org.key : '';
    const clientId = typeof org.clientId === 'string' ? org.clientId : '';
    if (!domain.ok || !key || !clientId) continue;
    if (orgs.some((o) => o.key === key || o.host === domain.host)) continue;
    orgs.push({
      key,
      name: typeof org.name === 'string' && org.name ? org.name : key,
      myDomain: domain.origin,
      host: domain.host,
      sandbox: org.sandbox === true,
      enabled: org.enabled !== false,
      clientId,
      scopes: stringList(org.scopes),
      policy: policyFromSettings(org),
    });
  }
  return orgs;
}

/** The connector whose My Domain an instance URL is, or null. */
export function orgForInstance(
  orgs: readonly SalesforceOrg[],
  instanceUrl: string
): SalesforceOrg | null {
  const parsed = parseMyDomain(instanceUrl);
  if (!parsed.ok) return null;
  return orgs.find((org) => org.host === parsed.host) ?? null;
}

/** A connector by key or (case-insensitive) name. */
export function findOrg(orgs: readonly SalesforceOrg[], ref: string): SalesforceOrg | null {
  const wanted = ref.trim().toLowerCase();
  return orgs.find((org) => org.key === wanted || org.name.toLowerCase() === wanted) ?? null;
}

/**
 * One connector as an admin saves it, checked against the others: a name,
 * the org's own My Domain (not login.salesforce.com or test.salesforce.com),
 * a consumer key, and no other connector on the same domain or name. An
 * existing connector keeps its key, so renaming keeps everyone's connections.
 */
export function validateOrg(
  input: unknown,
  others: readonly SalesforceOrg[],
  existingKey?: string
): { ok: true; org: SalesforceOrg } | { ok: false; error: string } {
  const entry = record(input);
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name) return { ok: false, error: 'Name this Salesforce connector (Production, UAT…).' };
  if (name.length > 60) return { ok: false, error: 'Keep the name under 60 characters.' };
  const domain = parseMyDomain(typeof entry.myDomain === 'string' ? entry.myDomain : '');
  if (!domain.ok) {
    return {
      ok: false,
      error:
        'The My Domain must be the org’s own (…my.salesforce.com), not login.salesforce.com or test.salesforce.com.',
    };
  }
  const clientId = typeof entry.clientId === 'string' ? entry.clientId.trim() : '';
  if (!clientId) return { ok: false, error: 'The consumer key is required.' };
  const rest = others.filter((org) => org.key !== existingKey);
  if (!existingKey && rest.length >= MAX_ORGS) {
    return { ok: false, error: `At most ${MAX_ORGS} Salesforce connectors.` };
  }
  let key = existingKey ?? orgKeyOf(name);
  if (!existingKey) {
    for (let n = 2; rest.some((org) => org.key === key); n += 1) key = `${orgKeyOf(name)}-${n}`;
  }
  if (rest.some((org) => org.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `Another Salesforce connector is already named ${name}.` };
  }
  const clash = rest.find((org) => org.host === domain.host);
  if (clash) return { ok: false, error: `${domain.host} is already the ${clash.name} connector.` };
  const policy = validatePolicy(entry);
  if (!policy.ok) return policy;
  return {
    ok: true,
    org: {
      key,
      name,
      myDomain: domain.origin,
      host: domain.host,
      sandbox: entry.sandbox === true,
      enabled: entry.enabled !== false,
      clientId,
      scopes: stringList(entry.scopes),
      policy: policy.policy,
    },
  };
}
