/**
 * Which Salesforce connector (org) a tool call acts in.
 *
 * Every salesforce_ tool takes an optional `org` — a connector's name or key
 * (Production, UAT…). index.ts adds it to each tool's input and runs the
 * handler inside `orgCall`, carrying the org asked for and the tool's name,
 * so resolving access is one place: pick the person's connection to that
 * connector, and refuse a tool the connection's own capabilities do not
 * cover (registration only knows the union across a person's connections).
 *
 * With no `org`: a person connected to one org gets it; connected to
 * several, production when exactly one is, and otherwise a refusal naming
 * them — never a guess about which org a write lands in.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { findOrg, type SalesforceOrg } from '@renkei/connector-salesforce';
import type { SalesforceConnection } from '@/lib/salesforce-grants';

export const orgCall = new AsyncLocalStorage<{ org?: string; tool: string }>();

export const orgField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Which Salesforce org: a connector’s name or key (Production, UAT…), as salesforce_list_orgs ' +
      'lists them. Optional when the person is connected to one org, or to one production org; ' +
      'name it to act in a sandbox.'
  );

export type OrgChoice =
  { ok: true; org: SalesforceOrg; connection: SalesforceConnection } | { ok: false; error: string };

function names(orgs: readonly SalesforceOrg[]): string {
  return orgs.map((org) => `${org.name}${org.sandbox ? ' (sandbox)' : ''}`).join(', ');
}

/**
 * The connection to use, from the switched-on connectors, the person's
 * connections, the org asked for and the capabilities the tool needs.
 */
export function chooseConnection(
  connectors: readonly SalesforceOrg[],
  connections: readonly SalesforceConnection[],
  ref: string | undefined,
  needs: readonly string[]
): OrgChoice {
  const live = connectors.filter((org) => org.enabled);
  const connected = live.filter((org) => connections.some((c) => c.connector === org.key));
  if (live.length === 0) {
    return { ok: false, error: 'Salesforce is not set up for this organization.' };
  }
  let org: SalesforceOrg | null;
  if (ref) {
    org = findOrg(live, ref);
    if (!org) {
      return {
        ok: false,
        error: `There is no Salesforce org "${ref}". The organization’s Salesforce orgs: ${names(live)}.`,
      };
    }
    if (!connected.includes(org)) {
      return {
        ok: false,
        error: `You are not connected to Salesforce ${org.name}. Connect it on the Connectors page, then try again.`,
      };
    }
  } else if (connected.length === 1) {
    org = connected[0];
  } else if (connected.length === 0) {
    return {
      ok: false,
      error: 'Salesforce is not connected. Connect an org on the Connectors page, then try again.',
    };
  } else {
    const production = connected.filter((candidate) => !candidate.sandbox);
    if (production.length !== 1) {
      return {
        ok: false,
        error: `You are connected to several Salesforce orgs (${names(connected)}); say which with org.`,
      };
    }
    org = production[0];
  }
  const connection = connections.find((c) => c.connector === org.key);
  if (!connection) return { ok: false, error: `You are not connected to Salesforce ${org.name}.` };
  const missing = needs.filter(
    (scope) => scope !== '__unmapped__' && !connection.requestedScopes.includes(scope)
  );
  if (needs.includes('__unmapped__')) {
    return { ok: false, error: 'This tool is not mapped to a Salesforce capability.' };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Your Salesforce ${org.name} connection does not allow this (${missing.join(', ')}). ` +
        'Reconnect that org on the Connectors page with it ticked, if your organization allows it.',
    };
  }
  return { ok: true, org, connection };
}
