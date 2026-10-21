/**
 * What a Salesforce connector keeps away from the model, whatever the
 * person could see in Salesforce (docs/salesforce-connectors-design.md,
 * "Health and other sensitive records"): objects (a case-note or payroll
 * object), single fields (`Contact.Diagnosis__c`), and — with one switch —
 * every field the org's data classification marks Restricted or Mission
 * Critical. These only take things away; they never grant anything
 * Salesforce would refuse.
 *
 * Pure: the web layer fetches the classifications and describes, and asks
 * these functions what to drop or refuse. Names compare case-insensitively,
 * as Salesforce's do.
 */

import { isSoqlIdentifier } from './soql';

export interface DataPolicy {
  /** Object API names hidden from every tool. */
  excludedObjects: string[];
  /** `Object.Field` API names hidden from every tool. */
  excludedFields: string[];
  /** Hide fields classified Restricted or Mission Critical. */
  hideRestricted: boolean;
}

export const EMPTY_POLICY: DataPolicy = {
  excludedObjects: [],
  excludedFields: [],
  hideRestricted: false,
};

/** The data classifications the Restricted switch hides (FieldDefinition.SecurityClassification). */
export const HIDDEN_CLASSIFICATIONS = ['Restricted', 'MissionCritical'];

export const MAX_EXCLUSIONS = 200;

function names(value: unknown): string[] {
  const list =
    typeof value === 'string'
      ? value.split(/[\s,]+/)
      : Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : [];
  return list.map((v) => v.trim()).filter(Boolean);
}

/** A connector's saved policy, defensively: entries that are not names are dropped. */
export function policyFromSettings(entry: unknown): DataPolicy {
  const org =
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? { ...entry } : {};
  const value = (key: string): unknown => (key in org ? Reflect.get(org, key) : undefined);
  return {
    excludedObjects: names(value('excludedObjects')).filter(isObjectName),
    excludedFields: names(value('excludedFields')).filter(isFieldRef),
    hideRestricted: value('hideRestricted') === true,
  };
}

function isObjectName(value: string): boolean {
  return isSoqlIdentifier(value) && !value.includes('.');
}

function isFieldRef(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 2 && parts.every(isObjectName);
}

/** An admin's policy input, normalized (deduplicated, sorted), or what is wrong with it. */
export function validatePolicy(
  input: unknown
): { ok: true; policy: DataPolicy } | { ok: false; error: string } {
  const entry =
    typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...input } : {};
  const objects = names(Reflect.get(entry, 'excludedObjects'));
  const fields = names(Reflect.get(entry, 'excludedFields'));
  const badObjects = objects.filter((name) => !isObjectName(name));
  if (badObjects.length > 0) {
    return { ok: false, error: `Not object API names: ${badObjects.join(', ')}.` };
  }
  const badFields = fields.filter((name) => !isFieldRef(name));
  if (badFields.length > 0) {
    return {
      ok: false,
      error: `Hidden fields are Object.Field API names (Contact.Diagnosis__c): ${badFields.join(', ')}.`,
    };
  }
  if (objects.length + fields.length > MAX_EXCLUSIONS) {
    return {
      ok: false,
      error: `At most ${MAX_EXCLUSIONS} hidden objects and fields per connector.`,
    };
  }
  const unique = (list: string[]) =>
    [...new Map(list.map((name) => [name.toLowerCase(), name])).values()].sort((a, b) =>
      a.localeCompare(b)
    );
  return {
    ok: true,
    policy: {
      excludedObjects: unique(objects),
      excludedFields: unique(fields),
      hideRestricted: Reflect.get(entry, 'hideRestricted') === true,
    },
  };
}

/** True when the policy hides nothing — the tools can skip every check. */
export function isEmptyPolicy(policy: DataPolicy): boolean {
  return (
    policy.excludedObjects.length === 0 &&
    policy.excludedFields.length === 0 &&
    !policy.hideRestricted
  );
}

export function isObjectHidden(policy: DataPolicy, object: string): boolean {
  const wanted = object.toLowerCase();
  return policy.excludedObjects.some((name) => name.toLowerCase() === wanted);
}

/**
 * The fields of `object` the policy hides, lower-cased: the ones listed by
 * name, and — when the switch is on — those `restricted` names (the
 * object's fields with a hidden classification, which the caller read).
 */
export function hiddenFieldsOf(
  policy: DataPolicy,
  object: string,
  restricted: readonly string[] = []
): Set<string> {
  const prefix = `${object.toLowerCase()}.`;
  const hidden = new Set(
    policy.excludedFields
      .map((ref) => ref.toLowerCase())
      .filter((ref) => ref.startsWith(prefix))
      .map((ref) => ref.slice(prefix.length))
  );
  if (policy.hideRestricted) for (const name of restricted) hidden.add(name.toLowerCase());
  return hidden;
}

/**
 * The identifiers a SOQL query names, outside string literals, each split
 * at its dots (`Account.Owner.Name` gives Account, Owner, Name) and
 * lower-cased — what the query reads, filters or groups by.
 */
export function soqlIdentifierParts(soql: string): Set<string> {
  const parts = new Set<string>();
  let text = '';
  let inString = false;
  for (let i = 0; i < soql.length; i += 1) {
    const ch = soql.charAt(i);
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === "'") inString = false;
      text += ' ';
      continue;
    }
    if (ch === "'") {
      inString = true;
      text += ' ';
      continue;
    }
    text += ch;
  }
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*/g)) {
    for (const part of match[0].split('.')) parts.add(part.toLowerCase());
  }
  return parts;
}

/** The objects a query reads FROM, at the top level and in subqueries (relationship names included). */
export function soqlFromNames(soql: string): string[] {
  return [...soql.matchAll(/\bfrom\s+([A-Za-z][A-Za-z0-9_]*)/gi)].map((match) => match[1]);
}

/**
 * Why a model-written query may not run under the policy, or null. Refuses
 * a query that names a hidden object anywhere, or a hidden field anywhere —
 * by its own name, whichever object it is reached through. That is broader
 * than strictly needed (a same-named field on another object is refused
 * too), which is the safe direction: a filter on a hidden field would leak
 * it as surely as selecting it. `hiddenByObject` is each FROM object's
 * hidden fields (hiddenFieldsOf), lower-cased names.
 */
export function policyRefusalForQuery(
  soql: string,
  policy: DataPolicy,
  hiddenByObject: ReadonlyMap<string, ReadonlySet<string>>
): string | null {
  const parts = soqlIdentifierParts(soql);
  const objects = policy.excludedObjects.filter((name) => parts.has(name.toLowerCase()));
  if (objects.length > 0) {
    return `Your organization keeps ${objects.join(', ')} away from the assistant, so it cannot be queried here.`;
  }
  const fields = new Set<string>();
  for (const ref of policy.excludedFields) fields.add(ref.split('.')[1].toLowerCase());
  for (const hidden of hiddenByObject.values()) for (const name of hidden) fields.add(name);
  const named = [...fields].filter((name) => parts.has(name));
  if (named.length > 0) {
    return `Your organization keeps these fields away from the assistant: ${named.join(', ')}. Leave them out of the query.`;
  }
  if (policy.excludedObjects.length > 0 && /\btypeof\b/i.test(soql)) {
    // TYPEOF picks fields per polymorphic target; the targets it may reach
    // are not all named in the query.
    return 'TYPEOF cannot be used while some objects are kept away from the assistant.';
  }
  return null;
}

/** The record types (attributes.type) in a query or search answer, nested ones included. */
export function recordTypesIn(records: readonly unknown[]): Set<string> {
  const types = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'attributes') {
        const type =
          typeof inner === 'object' && inner !== null ? Reflect.get(inner, 'type') : undefined;
        if (typeof type === 'string') types.add(type);
      } else if (key === 'records' || (typeof inner === 'object' && inner !== null)) {
        visit(inner);
      }
    }
  };
  visit(records);
  return types;
}

/**
 * Records with what the policy hides taken out, `attributes` still on:
 * fields hidden for the record's own type are dropped, and a nested record
 * of a hidden object (a parent through a lookup, a subquery's children) is
 * replaced by null. A top-level record of a hidden object is dropped.
 * `hiddenByType` is keyed by lower-cased type; a type missing from it hides
 * nothing (the caller fetched every type recordTypesIn reported).
 */
export function scrubRecords(
  records: readonly Record<string, unknown>[],
  policy: DataPolicy,
  hiddenByType: ReadonlyMap<string, ReadonlySet<string>>
): Record<string, unknown>[] {
  const typeOf = (record: Record<string, unknown>): string => {
    const attributes = record.attributes;
    const type =
      typeof attributes === 'object' && attributes !== null
        ? Reflect.get(attributes, 'type')
        : undefined;
    return typeof type === 'string' ? type : '';
  };
  const scrub = (record: Record<string, unknown>): Record<string, unknown> | null => {
    const type = typeOf(record);
    if (type && isObjectHidden(policy, type)) return null;
    const hidden = hiddenByType.get(type.toLowerCase()) ?? new Set<string>();
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'attributes' && hidden.has(key.toLowerCase())) continue;
      if (
        key !== 'attributes' &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const nested = { ...value };
        const children = Reflect.get(nested, 'records');
        if (Array.isArray(children)) {
          const kept = children
            .filter(
              (child): child is Record<string, unknown> =>
                typeof child === 'object' && child !== null
            )
            .map(scrub)
            .filter((child): child is Record<string, unknown> => child !== null);
          out[key] = { ...nested, records: kept, totalSize: kept.length };
        } else {
          out[key] = scrub(nested);
        }
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  return records.map(scrub).filter((record): record is Record<string, unknown> => record !== null);
}

/**
 * The names in a report's definition (columns, groupings, filters,
 * aggregates — `ACCOUNT.NAME`, `Site_Visit__c.Notes__c`, `s!Amount`) that
 * touch what the policy hides by name. Reports carry their own column
 * names, so this matches each name's dot-separated parts against the
 * hidden objects and the hidden fields' names; a report is refused whole
 * rather than shown with holes.
 */
export function reportNamesHidden(policy: DataPolicy, reportNames: readonly string[]): string[] {
  const objects = new Set(policy.excludedObjects.map((name) => name.toLowerCase()));
  const fields = new Set(policy.excludedFields.map((ref) => ref.split('.')[1].toLowerCase()));
  return reportNames.filter((name) =>
    name
      .replace(/^[a-z]!/i, '')
      .split('.')
      .some((part) => objects.has(part.toLowerCase()) || fields.has(part.toLowerCase()))
  );
}
