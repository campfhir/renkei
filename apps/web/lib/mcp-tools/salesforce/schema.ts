/**
 * The org's schema as the tools see it — describe-global and per-object
 * describes, cached per person and org for ten minutes (a person's describe
 * reflects their own field-level security, so it is never shared between
 * people) — and turning what a person said into ids: an object by API name
 * or label, a record by id, external id or name, a user or queue for an
 * owner. Ambiguity is refused with the candidates named, never guessed.
 */

import {
  findByNameOrLabel,
  isSalesforceId,
  keyPrefix,
  nameFieldOf,
  soqlContains,
  soqlString,
  to18,
  type DescribeSObject,
  type GlobalSObject,
} from '@renkei/connector-salesforce';
import {
  rec,
  recs,
  sfGet,
  sfQuery,
  str,
  type SalesforceAccess,
  type SalesforceCallContext,
} from './client';

const TTL_MS = 10 * 60_000;

interface Cached<T> {
  value: T;
  at: number;
}

const globals = new Map<string, Cached<GlobalSObject[]>>();
const describes = new Map<string, Cached<DescribeSObject>>();

function cacheKey(access: SalesforceAccess, object = ''): string {
  return `${access.accountId}|${object.toLowerCase()}`;
}

/** Forget one object's describe for this connection (a write said the schema moved), or everything. */
export function invalidateDescribe(access?: SalesforceAccess, object?: string): void {
  if (!access) {
    globals.clear();
    describes.clear();
    return;
  }
  if (object) describes.delete(cacheKey(access, object));
  else {
    for (const key of [...describes.keys()]) {
      if (key.startsWith(`${access.accountId}|`)) describes.delete(key);
    }
    globals.delete(cacheKey(access));
  }
}

export async function globalDescribe(
  context: SalesforceCallContext,
  access: SalesforceAccess
): Promise<GlobalSObject[] | string> {
  const key = cacheKey(access);
  const hit = globals.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const result = await sfGet(context, access, '/sobjects');
  if (!result.ok) return result.error;
  const objects: GlobalSObject[] = recs(rec(result.body).sobjects).map((entry) => ({
    name: str(entry.name),
    label: str(entry.label),
    labelPlural: str(entry.labelPlural),
    keyPrefix: typeof entry.keyPrefix === 'string' ? entry.keyPrefix : null,
    custom: entry.custom === true,
    queryable: entry.queryable === true,
    searchable: entry.searchable === true,
    createable: entry.createable === true,
    layoutable: entry.layoutable === true,
    deprecatedAndHidden: entry.deprecatedAndHidden === true,
  }));
  globals.set(key, { value: objects, at: Date.now() });
  return objects;
}

export async function describeObject(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  apiName: string
): Promise<DescribeSObject | string> {
  const key = cacheKey(access, apiName);
  const hit = describes.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const result = await sfGet(context, access, `/sobjects/${encodeURIComponent(apiName)}/describe`);
  if (!result.ok) return result.error;
  const body = rec(result.body);
  // The describe is Salesforce's documented shape; the package's types name
  // the subset the tools read, and every read of it is defensive.
  const describe: DescribeSObject = {
    name: str(body.name),
    label: str(body.label),
    labelPlural: str(body.labelPlural),
    keyPrefix: typeof body.keyPrefix === 'string' ? body.keyPrefix : null,
    custom: body.custom === true,
    createable: body.createable === true,
    updateable: body.updateable === true,
    deletable: body.deletable === true,
    queryable: body.queryable === true,
    searchable: body.searchable === true,
    fields: recs(body.fields).map((field) => ({
      name: str(field.name),
      label: str(field.label),
      type: str(field.type),
      length: typeof field.length === 'number' ? field.length : undefined,
      custom: field.custom === true,
      nillable: field.nillable === true,
      createable: field.createable === true,
      updateable: field.updateable === true,
      defaultedOnCreate: field.defaultedOnCreate === true,
      calculated: field.calculated === true,
      autoNumber: field.autoNumber === true,
      externalId: field.externalId === true,
      unique: field.unique === true,
      nameField: field.nameField === true,
      idLookup: field.idLookup === true,
      filterable: field.filterable === true,
      groupable: field.groupable === true,
      cascadeDelete: field.cascadeDelete === true,
      restrictedPicklist: field.restrictedPicklist === true,
      dependentPicklist: field.dependentPicklist === true,
      controllerName: typeof field.controllerName === 'string' ? field.controllerName : null,
      picklistValues: recs(field.picklistValues).map((entry) => ({
        value: str(entry.value),
        label: str(entry.label),
        active: entry.active === true,
        defaultValue: entry.defaultValue === true,
        validFor: typeof entry.validFor === 'string' ? entry.validFor : null,
      })),
      referenceTo: Array.isArray(field.referenceTo)
        ? field.referenceTo.filter((v): v is string => typeof v === 'string')
        : [],
      relationshipName: typeof field.relationshipName === 'string' ? field.relationshipName : null,
      inlineHelpText: typeof field.inlineHelpText === 'string' ? field.inlineHelpText : null,
      compoundFieldName:
        typeof field.compoundFieldName === 'string' ? field.compoundFieldName : null,
      htmlFormatted: field.htmlFormatted === true,
    })),
    childRelationships: recs(body.childRelationships).map((rel) => ({
      childSObject: str(rel.childSObject),
      field: str(rel.field),
      relationshipName: typeof rel.relationshipName === 'string' ? rel.relationshipName : null,
      cascadeDelete: rel.cascadeDelete === true,
    })),
    recordTypeInfos: recs(body.recordTypeInfos).map((info) => ({
      recordTypeId: str(info.recordTypeId),
      name: str(info.name),
      developerName: str(info.developerName),
      available: info.available === true,
      defaultRecordTypeMapping: info.defaultRecordTypeMapping === true,
      master: info.master === true,
    })),
  };
  describes.set(key, { value: describe, at: Date.now() });
  return describe;
}

/** An object by API name, label or plural label — refusing a label two objects share. */
export async function resolveObject(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  input: string
): Promise<DescribeSObject | string> {
  const objects = await globalDescribe(context, access);
  if (typeof objects === 'string') return objects;
  const found = findByNameOrLabel(objects, input);
  if (found.kind === 'ambiguous') {
    return `"${input}" names more than one object: ${found.candidates
      .map((o) => `${o.name} (${o.label})`)
      .join(', ')}. Use the API name.`;
  }
  if (found.kind === 'none') {
    const wanted = input.toLowerCase();
    const close = objects
      .filter(
        (o) =>
          o.queryable &&
          (o.name.toLowerCase().includes(wanted) || o.label.toLowerCase().includes(wanted))
      )
      .slice(0, 8)
      .map((o) => `${o.name} (${o.label})`);
    return `No object "${input}" is visible to your Salesforce user${close.length ? ` — did you mean ${close.join(', ')}?` : '. salesforce_list_objects lists them.'}`;
  }
  return describeObject(context, access, found.value.name);
}

/** The object an id belongs to, from its key prefix. */
export async function objectOfId(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  id: string
): Promise<DescribeSObject | string> {
  const objects = await globalDescribe(context, access);
  if (typeof objects === 'string') return objects;
  const prefix = keyPrefix(id);
  const match = objects.find((o) => o.keyPrefix === prefix);
  if (!match) return `No object visible to your Salesforce user has ids starting ${prefix}.`;
  return describeObject(context, access, match.name);
}

export interface ResolvedRecord {
  id: string;
  name: string;
}

/** The identifying fields of an object: its name field, then compact layout text fields. */
async function identifyingFields(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  describe: DescribeSObject
): Promise<string[]> {
  const fields: string[] = [];
  const nameField = nameFieldOf(describe);
  if (nameField) fields.push(nameField.name);
  const layouts = await sfGet(
    context,
    access,
    `/sobjects/${encodeURIComponent(describe.name)}/describe/compactLayouts/primary`
  );
  if (layouts.ok) {
    for (const item of recs(rec(layouts.body).fieldItems)) {
      for (const component of recs(item.layoutComponents)) {
        const name = str(component.value);
        const field = describe.fields.find((f) => f.name === name);
        if (
          field &&
          ['string', 'email', 'phone', 'url', 'picklist'].includes(field.type) &&
          !fields.includes(name)
        ) {
          fields.push(name);
        }
      }
    }
  }
  return fields.slice(0, 4);
}

/**
 * A record of `describe` from what a person said: an id (15 or 18), an
 * exact name, or text matching its name or identifying fields. One match is
 * the answer; several are refused with their ids.
 */
export async function resolveRecord(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  describe: DescribeSObject,
  ref: string
): Promise<ResolvedRecord | string> {
  const input = ref.trim();
  if (!input) return `Name the ${describe.label} — its id or name.`;
  const nameField = nameFieldOf(describe);
  const nameOf = (record: Record<string, unknown>) =>
    (nameField ? str(record[nameField.name]) : '') || str(record.Id);

  if (isSalesforceId(input)) {
    const id = to18(input);
    const select = nameField ? `Id, ${nameField.name}` : 'Id';
    const found = await sfQuery(
      context,
      access,
      `SELECT ${select} FROM ${describe.name} WHERE Id = ${soqlString(id)} LIMIT 1`
    );
    if (!found.ok) return found.error;
    const record = found.records[0];
    if (!record) return `No ${describe.label} with id ${id} is visible to your Salesforce user.`;
    return { id: str(record.Id), name: nameOf(record) };
  }

  const fields = await identifyingFields(context, access, describe);
  if (fields.length === 0) {
    return `${describe.label} records have no name to look up; give the record's id.`;
  }
  const select = ['Id', ...fields].join(', ');
  if (nameField) {
    const exact = await sfQuery(
      context,
      access,
      `SELECT ${select} FROM ${describe.name} WHERE ${nameField.name} = ${soqlString(input)} LIMIT 6`
    );
    if (!exact.ok) return exact.error;
    if (exact.records.length === 1)
      return { id: str(exact.records[0].Id), name: nameOf(exact.records[0]) };
    if (exact.records.length > 1) return ambiguous(describe, input, exact.records, fields);
  }
  // Every word must appear in one of the identifying fields — "the site
  // visit for Acme in March" against an auto-numbered object's compact
  // layout — which works whether or not the object allows search.
  const words = input.split(/\s+/).filter(Boolean).slice(0, 6);
  const filterable = fields.filter(
    (name) => describe.fields.find((f) => f.name === name)?.filterable !== false
  );
  if (filterable.length === 0) {
    return `${describe.label} records cannot be looked up by name; give the record's id.`;
  }
  const conditions = words.map(
    (word) => `(${filterable.map((name) => `${name} LIKE ${soqlContains(word)}`).join(' OR ')})`
  );
  const like = await sfQuery(
    context,
    access,
    `SELECT ${select} FROM ${describe.name} WHERE ${conditions.join(' AND ')} LIMIT 6`
  );
  if (!like.ok) return like.error;
  if (like.records.length === 1)
    return { id: str(like.records[0].Id), name: nameOf(like.records[0]) };
  if (like.records.length > 1) return ambiguous(describe, input, like.records, fields);
  return `No ${describe.label} matching "${input}" is visible to your Salesforce user.`;
}

function ambiguous(
  describe: DescribeSObject,
  input: string,
  records: Record<string, unknown>[],
  fields: string[]
): string {
  const lines = records.slice(0, 5).map(
    (record) =>
      `  • ${str(record.Id)} — ${fields
        .map((f) => str(record[f]))
        .filter(Boolean)
        .join(' · ')}`
  );
  return [
    `"${input}" matches more than one ${describe.label}${records.length > 5 ? ' (first 5 shown)' : ''}:`,
    ...lines,
    'Say which one by id.',
  ].join('\n');
}

/**
 * A user (active) or a queue, for an owner or assignee: an id, an exact
 * name, a username or an email.
 */
export async function resolveOwner(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  ref: string,
  allowQueue: boolean
): Promise<(ResolvedRecord & { kind: 'User' | 'Queue' }) | string> {
  const input = ref.trim();
  if (!input) return 'Name the user — their name, username, email or id.';
  if (/^me$/i.test(input)) {
    return { id: to18(access.userId), name: access.username || 'you', kind: 'User' };
  }
  if (isSalesforceId(input)) {
    const prefix = keyPrefix(input);
    if (prefix === '005') {
      const found = await sfQuery(
        context,
        access,
        `SELECT Id, Name FROM User WHERE Id = ${soqlString(to18(input))} LIMIT 1`
      );
      if (!found.ok) return found.error;
      const user = found.records[0];
      return user
        ? { id: str(user.Id), name: str(user.Name), kind: 'User' }
        : `No user with id ${input}.`;
    }
    if (prefix === '00G' && allowQueue) {
      const found = await sfQuery(
        context,
        access,
        `SELECT Id, Name FROM Group WHERE Id = ${soqlString(to18(input))} AND Type = 'Queue' LIMIT 1`
      );
      if (!found.ok) return found.error;
      const queue = found.records[0];
      return queue
        ? { id: str(queue.Id), name: str(queue.Name), kind: 'Queue' }
        : `No queue with id ${input}.`;
    }
    return `${input} is not a user${allowQueue ? ' or queue' : ''} id.`;
  }
  const literal = soqlString(input);
  const users = await sfQuery(
    context,
    access,
    `SELECT Id, Name, Username FROM User WHERE IsActive = true AND (Name = ${literal} OR Username = ${literal} OR Email = ${literal}) LIMIT 6`
  );
  if (!users.ok) return users.error;
  const queues = allowQueue
    ? await sfQuery(
        context,
        access,
        `SELECT Id, Name FROM Group WHERE Type = 'Queue' AND (Name = ${literal} OR DeveloperName = ${literal}) LIMIT 6`
      )
    : { ok: true as const, records: [], totalSize: 0, next: null };
  if (!queues.ok) return queues.error;
  const matches = [
    ...users.records.map((u) => ({
      id: str(u.Id),
      name: str(u.Name),
      detail: str(u.Username),
      kind: 'User' as const,
    })),
    ...queues.records.map((q) => ({
      id: str(q.Id),
      name: str(q.Name),
      detail: 'queue',
      kind: 'Queue' as const,
    })),
  ];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    return `No active user${allowQueue ? ' or queue' : ''} named "${input}" (by name, username or email).`;
  }
  return [
    `"${input}" matches more than one:`,
    ...matches.map((m) => `  • ${m.id} — ${m.name} (${m.detail})`),
    'Say which one by id.',
  ].join('\n');
}

/**
 * The picklist values a record type allows, per field, from
 * describe/layouts/<recordTypeId> — what the person's page offers.
 */
export async function recordTypePicklists(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  recordTypeId: string
): Promise<Record<string, string[]> | undefined> {
  const result = await sfGet(
    context,
    access,
    `/sobjects/${encodeURIComponent(object)}/describe/layouts/${encodeURIComponent(recordTypeId)}`
  );
  if (!result.ok) return undefined;
  const picklists: Record<string, string[]> = {};
  for (const mapping of recs(rec(result.body).recordTypeMappings)) {
    if (to18(str(mapping.recordTypeId)) !== to18(recordTypeId)) continue;
    for (const picklist of recs(mapping.picklistsForRecordType)) {
      picklists[str(picklist.picklistName)] = recs(picklist.picklistValues).map((v) =>
        str(v.value)
      );
    }
  }
  return Object.keys(picklists).length > 0 ? picklists : undefined;
}

/** A record type by id, name or developer name, among those available to the person. */
export function resolveRecordType(
  describe: DescribeSObject,
  input: string
): string | { error: string } {
  const available = (describe.recordTypeInfos ?? []).filter(
    (info) => info.available && !info.master
  );
  const wanted = input.trim().toLowerCase();
  const match = available.find(
    (info) =>
      to18(info.recordTypeId).toLowerCase() === to18(input.trim()).toLowerCase() ||
      info.name.toLowerCase() === wanted ||
      info.developerName.toLowerCase() === wanted
  );
  if (match) return match.recordTypeId;
  return {
    error: `${describe.label} has no record type "${input}" available to you${
      available.length ? `. Available: ${available.map((info) => info.name).join(', ')}` : ''
    }.`,
  };
}
