/**
 * A person's Salesforce connections — one grant per Salesforce connector
 * (org) they connected — read from provider_grants without opening any
 * token: the rows' metadata (which connector, which org, the username) and
 * the capabilities they asked for are plain columns. The grant's account id
 * is `<orgId>/<userId>`; `connector` is the Salesforce connector's key.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { SALESFORCE, readSalesforceMetadata } from '@renkei/provider-grants';
import { orgForInstance, type SalesforceOrg } from '@renkei/connector-salesforce';

export interface SalesforceConnection {
  accountId: string;
  /** The Salesforce connector (org) this connection is to, or null when no connector matches it any more. */
  connector: string | null;
  displayName: string;
  username: string;
  instanceUrl: string;
  requestedScopes: string[];
}

/** `provider` is the connector type's grant provider: the CRM's by default, or `salesforce-admin`. */
export async function listSalesforceConnections(
  db: Kysely<DB>,
  subject: string,
  connectors: readonly SalesforceOrg[],
  provider: string = SALESFORCE
): Promise<SalesforceConnection[]> {
  const rows = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'display_name', 'metadata', 'requested_scopes'])
    .where('provider', '=', provider)
    .where('subject', '=', subject)
    .execute();
  return rows.map((row) => {
    const metadata =
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? { ...row.metadata }
        : {};
    const parsed = readSalesforceMetadata(metadata);
    // The connector the grant names, while it still is that connector's org;
    // otherwise whichever connector now has its org (re-added under a new key).
    const named = typeof metadata.connector === 'string' ? metadata.connector : '';
    const byInstance = orgForInstance(connectors, parsed.instanceUrl);
    const connector =
      connectors.find((org) => org.key === named && org.host === byInstance?.host)?.key ??
      byInstance?.key ??
      null;
    return {
      accountId: row.provider_account_id,
      connector,
      displayName: row.display_name,
      username: parsed.username,
      instanceUrl: parsed.instanceUrl,
      requestedScopes: row.requested_scopes ?? [],
    };
  });
}
