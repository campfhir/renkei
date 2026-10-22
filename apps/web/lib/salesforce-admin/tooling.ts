/**
 * The Tooling API reads every admin read and precondition shares: one page
 * of a `/tooling/query`, and the hash that tells whether a component moved
 * since a proposal read it.
 */

import { createHash } from 'node:crypto';
import { soqlString } from '@renkei/connector-salesforce';
import {
  rec,
  recs,
  sfGet,
  sfQuery,
  str,
  type SalesforceAccess,
  type SalesforceCallContext,
} from '@/lib/mcp-tools/salesforce/client';

/** A hash of a component's metadata as read, to tell whether it moved since. */
export function fingerprintOf(metadata: unknown): string {
  return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}

/** A Tooling API query (`/tooling/query`), one page. */
export async function toolingQuery(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  soql: string
): Promise<{ ok: true; records: Record<string, unknown>[] } | { ok: false; error: string }> {
  const result = await sfGet(context, access, `/tooling/query?q=${encodeURIComponent(soql)}`);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, records: recs(rec(result.body).records) };
}

/** The key the Tooling API files an object's fields and layouts under: its name, or 01I… for a custom one. */
export async function entityKey(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string
): Promise<string | null> {
  const found = await sfQuery(
    context,
    access,
    `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${soqlString(object)} LIMIT 1`
  );
  return found.ok ? str(found.records[0]?.DurableId) || null : null;
}
