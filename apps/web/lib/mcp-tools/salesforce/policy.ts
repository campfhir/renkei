/**
 * Applying a connector's data policy (@renkei/connector-salesforce
 * policy.ts) to what the tools read: which fields of an object are hidden —
 * the ones the admin listed, and, with the Restricted switch on, the ones
 * the org's data classification marks Restricted or Mission Critical — and
 * queries that refuse to name hidden things and return without them.
 *
 * The classification comes from FieldDefinition.SecurityClassification,
 * read as the person and cached per org and object for ten minutes (it is
 * org metadata, the same for everyone). When it cannot be read, the object
 * is refused rather than shown unfiltered: the switch fails closed.
 *
 * schema.ts filters every describe through hiddenFields, so tools that work
 * from a describe (writes, record lookups, listings) never see a hidden
 * field or object; the query helpers here cover what a model writes itself
 * (SOQL) and what Salesforce returns beyond the describe (FIELDS(ALL),
 * relationship fields, subqueries).
 */

import {
  HIDDEN_CLASSIFICATIONS,
  hiddenFieldsOf,
  isEmptyPolicy,
  isObjectHidden,
  policyRefusalForQuery,
  recordTypesIn,
  scrubRecords,
  soqlFromNames,
  soqlString,
} from '@renkei/connector-salesforce';
import {
  rec,
  sfQueryRaw,
  str,
  stripAttributes,
  type SalesforceAccess,
  type SalesforceCallContext,
} from './client';

const TTL_MS = 10 * 60_000;
const classified = new Map<string, { names: string[]; at: number }>();

/** Forget cached classifications (tests; an admin's classification change shows within the TTL otherwise). */
export function resetClassifications(): void {
  classified.clear();
}

/** The object's fields with a hidden classification, or why they cannot be known. */
async function restrictedFieldsOf(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string
): Promise<string[] | string> {
  const key = `${access.orgId}|${object.toLowerCase()}`;
  const hit = classified.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  const page = await sfQueryRaw(
    context,
    access,
    `SELECT QualifiedApiName, SecurityClassification FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ${soqlString(object)}`
  );
  if (!page.ok) {
    return `Your organization hides fields classified Restricted in Salesforce, and how ${object}’s fields are classified could not be read (${page.error}), so ${object} is not shown.`;
  }
  const names = page.records
    .filter((row) => HIDDEN_CLASSIFICATIONS.includes(str(row.SecurityClassification)))
    .map((row) => str(row.QualifiedApiName))
    .filter(Boolean);
  classified.set(key, { names, at: Date.now() });
  return names;
}

/** Lower-cased names of the object's hidden fields, or a refusal for the whole object. */
export async function hiddenFields(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string
): Promise<Set<string> | string> {
  const { policy } = access;
  if (isObjectHidden(policy, object)) return objectRefusal(object);
  if (!policy.hideRestricted) return hiddenFieldsOf(policy, object);
  const restricted = await restrictedFieldsOf(context, access, object);
  if (typeof restricted === 'string') return restricted;
  return hiddenFieldsOf(policy, object, restricted);
}

export function objectRefusal(object: string): string {
  return `Your organization keeps ${object} away from the assistant, so it cannot be used here.`;
}

type QueryPage =
  | { ok: true; records: Record<string, unknown>[]; totalSize: number; next: string | null }
  | { ok: false; error: string };

/**
 * sfQuery under the policy: a query naming a hidden object or field is
 * refused before it runs, and what comes back has hidden fields, hidden
 * parents and hidden children taken out (FIELDS(ALL) included). The shape
 * is sfQuery's.
 */
export async function sfQueryPolicy(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  soqlOrCursor: string
): Promise<QueryPage> {
  const policy = access.policy;
  if (!soqlOrCursor.startsWith('/services/') && !isEmptyPolicy(policy)) {
    const byObject = new Map<string, Set<string>>();
    for (const name of soqlFromNames(soqlOrCursor)) {
      const hidden = await hiddenFields(context, access, name);
      if (typeof hidden === 'string') return { ok: false, error: hidden };
      byObject.set(name.toLowerCase(), hidden);
    }
    const refused = policyRefusalForQuery(soqlOrCursor, policy, byObject);
    if (refused) return { ok: false, error: refused };
  }
  const page = await sfQueryRaw(context, access, soqlOrCursor);
  if (!page.ok) return page;
  const records = await scrubbed(context, access, page.records);
  if (typeof records === 'string') return { ok: false, error: records };
  return { ...page, records: records.map(stripAttributes) };
}

/**
 * Records that still carry `attributes` (a query or search answer), with
 * what the policy hides taken out; `attributes` stay on.
 */
export async function scrubbed(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  records: Record<string, unknown>[]
): Promise<Record<string, unknown>[] | string> {
  if (isEmptyPolicy(access.policy)) return records;
  const byType = new Map<string, Set<string>>();
  for (const type of recordTypesIn(records)) {
    if (isObjectHidden(access.policy, type)) continue;
    const hidden = await hiddenFields(context, access, type);
    if (typeof hidden === 'string') return hidden;
    byType.set(type.toLowerCase(), hidden);
  }
  return scrubRecords(records, access.policy, byType);
}

/** The `attributes.type` of a raw record. */
export function typeOf(record: Record<string, unknown>): string {
  return str(rec(record.attributes).type);
}
