/**
 * The sObject describe, and checking a write against it.
 *
 * The CRM tools are generic — an object name and a map of fields — and the
 * describe types them at call time, the same way for standard objects,
 * custom ones and a managed package's. Nothing here knows any particular
 * org: unknown fields, read-only fields, wrong types, invalid picklist
 * values and missing required fields are refused with the valid choices
 * named, before anything is sent.
 */

import { isSalesforceId, to18 } from './ids';

export interface PicklistEntry {
  value: string;
  label: string;
  active: boolean;
  defaultValue?: boolean;
  /** Base64 bitmap of the controlling field's values this one is valid for. */
  validFor?: string | null;
}

export interface DescribeField {
  name: string;
  label: string;
  type: string;
  length?: number;
  custom?: boolean;
  nillable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  defaultedOnCreate?: boolean;
  calculated?: boolean;
  autoNumber?: boolean;
  externalId?: boolean;
  unique?: boolean;
  nameField?: boolean;
  idLookup?: boolean;
  filterable?: boolean;
  groupable?: boolean;
  cascadeDelete?: boolean;
  restrictedPicklist?: boolean;
  dependentPicklist?: boolean;
  controllerName?: string | null;
  picklistValues?: PicklistEntry[];
  referenceTo?: string[];
  relationshipName?: string | null;
  inlineHelpText?: string | null;
  compoundFieldName?: string | null;
  htmlFormatted?: boolean;
}

export interface ChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete?: boolean;
}

export interface RecordTypeInfo {
  recordTypeId: string;
  name: string;
  developerName: string;
  available: boolean;
  defaultRecordTypeMapping?: boolean;
  master?: boolean;
}

export interface DescribeSObject {
  name: string;
  label: string;
  labelPlural?: string;
  keyPrefix?: string | null;
  custom?: boolean;
  createable?: boolean;
  updateable?: boolean;
  deletable?: boolean;
  queryable?: boolean;
  searchable?: boolean;
  fields: DescribeField[];
  childRelationships?: ChildRelationship[];
  recordTypeInfos?: RecordTypeInfo[];
}

/** describeGlobal's entry for one object. */
export interface GlobalSObject {
  name: string;
  label: string;
  labelPlural?: string;
  keyPrefix?: string | null;
  custom?: boolean;
  queryable?: boolean;
  searchable?: boolean;
  createable?: boolean;
  layoutable?: boolean;
  deprecatedAndHidden?: boolean;
}

/**
 * Objects that are plumbing rather than records a person works with:
 * history, sharing, feed and change-event tables, tags and the like. Hidden
 * from the object list (still queryable by name — field history is read
 * through its `__History` table).
 */
export function isSystemObject(name: string): boolean {
  return /(?:History|Share|Feed|ChangeEvent|Tag|__e|__mdt|__x|__b)$/.test(name);
}

/** The org's own unnamespaced custom objects first, then other custom, then standard. */
export function sortObjectsForListing<T extends Pick<GlobalSObject, 'name' | 'custom' | 'label'>>(
  objects: T[]
): T[] {
  // `Site_Visit__c` is the org's own; `npsp__Allocation__c` is a package's.
  const rank = (o: T): number => (!o.custom ? 2 : o.name.split('__').length > 2 ? 1 : 0);
  return [...objects].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

type Found<T> =
  { kind: 'found'; value: T } | { kind: 'ambiguous'; candidates: T[] } | { kind: 'none' };

/**
 * An object or field by API name or label, case-insensitively: exact API
 * name first, then label (or plural label), refusing a label two of them
 * share rather than picking one.
 */
export function findByNameOrLabel<T extends { name: string; label: string; labelPlural?: string }>(
  items: readonly T[],
  input: string
): Found<T> {
  const wanted = input.trim().toLowerCase();
  if (!wanted) return { kind: 'none' };
  const byName = items.find((item) => item.name.toLowerCase() === wanted);
  if (byName) return { kind: 'found', value: byName };
  const byLabel = items.filter(
    (item) =>
      item.label.toLowerCase() === wanted || (item.labelPlural ?? '').toLowerCase() === wanted
  );
  if (byLabel.length === 1) return { kind: 'found', value: byLabel[0] };
  if (byLabel.length > 1) return { kind: 'ambiguous', candidates: byLabel };
  return { kind: 'none' };
}

/** Up to `max` field names a mistyped one probably meant: shared prefix or substring. */
export function similarFieldNames(describe: DescribeSObject, input: string, max = 5): string[] {
  const wanted = input
    .toLowerCase()
    .replace(/__c$/, '')
    .replace(/[^a-z0-9]/g, '');
  if (!wanted) return [];
  return describe.fields
    .map((field) => {
      const name = field.name
        .toLowerCase()
        .replace(/__c$/, '')
        .replace(/[^a-z0-9]/g, '');
      const label = field.label.toLowerCase().replace(/[^a-z0-9]/g, '');
      const score =
        name === wanted || label === wanted
          ? 3
          : name.includes(wanted) || wanted.includes(name) || label.includes(wanted)
            ? 2
            : name.slice(0, 4) === wanted.slice(0, 4)
              ? 1
              : 0;
      return { name: field.name, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((entry) => entry.name);
}

/** Why a field cannot be written, in the person's terms; null when it can. */
export function readOnlyReason(field: DescribeField, mode: 'create' | 'update'): string | null {
  if (field.calculated) {
    return `${field.name} is a ${field.type === 'summary' ? 'roll-up summary' : 'formula'} field — Salesforce computes it.`;
  }
  if (field.autoNumber) return `${field.name} is an auto-number field — Salesforce assigns it.`;
  if (mode === 'create' && field.createable === false) {
    return `${field.name} cannot be set when creating a ${field.type === 'id' ? 'record' : 'record of this object'}.`;
  }
  if (mode === 'update' && field.updateable === false) {
    return field.type === 'reference' && field.createable
      ? `${field.name} is set when the record is created and cannot be changed afterwards (a master-detail field that does not allow reparenting).`
      : `${field.name} cannot be changed.`;
  }
  return null;
}

/**
 * The controlling-field value indexes a dependent picklist entry is valid
 * for. `validFor` is base64; bit i, counted from the most significant bit of
 * the first byte, stands for the controlling field's value at index i (for a
 * checkbox controller: 0 = unchecked, 1 = checked).
 */
export function validForIndexes(validFor: string): number[] {
  const bytes = Buffer.from(validFor, 'base64');
  const indexes: number[] = [];
  for (let byte = 0; byte < bytes.length; byte += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      if (bytes[byte] & (0x80 >> bit)) indexes.push(byte * 8 + bit);
    }
  }
  return indexes;
}

export interface WriteCheckOptions {
  /** Values a record type allows per picklist field (from describe/layouts); absent = the field's own list. */
  recordTypePicklists?: Record<string, string[]>;
  /** The record's current values, for dependent picklists whose controller is not being sent (update). */
  current?: Record<string, unknown>;
}

export interface WriteCheck {
  /** The fields keyed by API name, values normalized (picklist value casing, 18-char ids, `;`-joined multi-selects). */
  values: Record<string, unknown>;
  errors: string[];
}

/**
 * Check a create or update against the describe. Field names may be API
 * names or labels; values are normalized to what Salesforce expects. Lookup
 * values must already be ids here — the tools resolve names to ids first.
 */
export function checkWrite(
  describe: DescribeSObject,
  fields: Record<string, unknown>,
  mode: 'create' | 'update',
  options: WriteCheckOptions = {}
): WriteCheck {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};
  // Fields named in the write, valid or not — a bad value is reported once,
  // as bad, not again as missing.
  const named = new Set<string>();

  for (const [key, raw] of Object.entries(fields)) {
    const found = findByNameOrLabel(describe.fields, key);
    if (found.kind === 'ambiguous') {
      errors.push(
        `"${key}" matches more than one field on ${describe.name}: ${found.candidates
          .map((field) => field.name)
          .join(', ')}. Use the API name.`
      );
      continue;
    }
    if (found.kind === 'none') {
      const similar = similarFieldNames(describe, key);
      errors.push(
        `${describe.name} has no field "${key}"${similar.length ? ` — did you mean ${similar.join(', ')}?` : '.'}`
      );
      continue;
    }
    const field = found.value;
    named.add(field.name);
    const reason = readOnlyReason(field, mode);
    if (reason) {
      errors.push(reason);
      continue;
    }
    const value = normalizeValue(field, raw, options);
    if (typeof value === 'object' && value !== null && 'error' in value) {
      errors.push(value.error);
      continue;
    }
    values[field.name] = value.value;
  }

  // Dependent picklists, once every value is known.
  for (const [name, value] of Object.entries(values)) {
    const field = describe.fields.find((candidate) => candidate.name === name);
    if (!field?.dependentPicklist || !field.controllerName || value === null) continue;
    const controller = describe.fields.find((candidate) => candidate.name === field.controllerName);
    if (!controller) continue;
    const controllerValue =
      controller.name in values ? values[controller.name] : options.current?.[controller.name];
    const problem = dependentPicklistProblem(field, controller, value, controllerValue);
    if (problem) errors.push(problem);
  }

  if (mode === 'create') {
    const missing = describe.fields.filter(
      (field) =>
        field.createable !== false &&
        field.nillable === false &&
        !field.defaultedOnCreate &&
        field.type !== 'boolean' &&
        field.type !== 'id' &&
        !named.has(field.name)
    );
    if (missing.length > 0) {
      errors.push(
        `Creating a ${describe.label} needs ${missing
          .map((field) => `${field.name} (${field.label})`)
          .join(', ')}.`
      );
    }
  }

  return { values, errors };
}

type Normalized = { value: unknown } | { error: string };

function normalizeValue(
  field: DescribeField,
  raw: unknown,
  options: WriteCheckOptions
): Normalized {
  if (raw === null || raw === '') {
    if (field.nillable === false && field.type !== 'boolean') {
      return { error: `${field.name} is required and cannot be cleared.` };
    }
    return { value: null };
  }
  switch (field.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
      return { error: `${field.name} is a checkbox — send true or false.` };
    }
    case 'int':
    case 'double':
    case 'currency':
    case 'percent': {
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(number)) return { error: `${field.name} is a number.` };
      if (field.type === 'int' && !Number.isInteger(number)) {
        return { error: `${field.name} is a whole number.` };
      }
      return { value: number };
    }
    case 'date': {
      if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return { value: raw };
      return { error: `${field.name} is a date — send YYYY-MM-DD.` };
    }
    case 'datetime': {
      if (
        typeof raw === 'string' &&
        !Number.isNaN(Date.parse(raw)) &&
        /^\d{4}-\d{2}-\d{2}T/.test(raw)
      ) {
        return { value: raw };
      }
      return { error: `${field.name} is a date and time — send ISO 8601 (2026-10-21T14:30:00Z).` };
    }
    case 'time': {
      if (typeof raw === 'string' && /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?$/.test(raw)) {
        return { value: raw };
      }
      return { error: `${field.name} is a time of day — send HH:MM:SS.` };
    }
    case 'reference': {
      if (typeof raw === 'string' && isSalesforceId(raw)) return { value: to18(raw) };
      return {
        error: `${field.name} is a lookup to ${(field.referenceTo ?? []).join(' or ') || 'another record'} — send the record's id.`,
      };
    }
    case 'picklist': {
      if (typeof raw !== 'string')
        return { error: `${field.name} is a picklist — send one value.` };
      return picklistValue(field, raw, options);
    }
    case 'multipicklist': {
      const parts = Array.isArray(raw)
        ? raw.map(String)
        : typeof raw === 'string'
          ? raw.split(';')
          : null;
      if (!parts)
        return { error: `${field.name} is a multi-select picklist — send a list of values.` };
      const normalized: string[] = [];
      for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
        const one = picklistValue(field, part, options);
        if ('error' in one) return one;
        normalized.push(String(one.value));
      }
      return { value: normalized.join(';') };
    }
    case 'location':
    case 'address': {
      return {
        error: `${field.name} is a compound ${field.type} field — set its parts (${field.name.replace(/__c$/, '')}__Latitude__s / __Longitude__s, or Street, City, …) instead.`,
      };
    }
    default: {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        return { error: `${field.name} is text.` };
      }
      const text = String(raw);
      if (field.length && text.length > field.length) {
        return {
          error: `${field.name} holds at most ${field.length} characters (got ${text.length}).`,
        };
      }
      return { value: text };
    }
  }
}

function picklistValue(field: DescribeField, raw: string, options: WriteCheckOptions): Normalized {
  const active = (field.picklistValues ?? []).filter((entry) => entry.active);
  const allowed = options.recordTypePicklists?.[field.name];
  const pool = allowed ? active.filter((entry) => allowed.includes(entry.value)) : active;
  const wanted = raw.trim().toLowerCase();
  const match = pool.find(
    (entry) => entry.value.toLowerCase() === wanted || entry.label.toLowerCase() === wanted
  );
  if (match) return { value: match.value };
  // An unrestricted picklist takes values outside its list; a record type's
  // subset is still enforced by Salesforce, so it is enforced here too.
  if (!field.restrictedPicklist && !allowed) return { value: raw };
  return {
    error: `"${raw}" is not a value of ${field.name}${allowed ? ' for this record type' : ''}. Valid values: ${pool
      .map((entry) => entry.value)
      .join(', ')}.`,
  };
}

function dependentPicklistProblem(
  field: DescribeField,
  controller: DescribeField,
  value: unknown,
  controllerValue: unknown
): string | null {
  const values = String(value).split(';');
  const controllerIndex =
    controller.type === 'boolean'
      ? controllerValue === true
        ? 1
        : 0
      : (controller.picklistValues ?? []).findIndex((entry) => entry.value === controllerValue);
  if (controllerIndex < 0) {
    return `${field.name} depends on ${controller.name}; set ${controller.name} first.`;
  }
  const allowed = (field.picklistValues ?? []).filter(
    (entry) =>
      entry.active && entry.validFor && validForIndexes(entry.validFor).includes(controllerIndex)
  );
  const bad = values.filter((one) => !allowed.some((entry) => entry.value === one));
  if (bad.length === 0) return null;
  return `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not valid for ${field.name} when ${controller.name} is ${String(controllerValue)}. Valid: ${
    allowed.map((entry) => entry.value).join(', ') || 'none'
  }.`;
}

/** The compact, model-readable form of a describe: what a model needs to build a write or a query. */
export function summarizeDescribe(describe: DescribeSObject): Record<string, unknown> {
  return {
    name: describe.name,
    label: describe.label,
    custom: describe.custom ?? false,
    createable: describe.createable,
    updateable: describe.updateable,
    deletable: describe.deletable,
    recordTypes: (describe.recordTypeInfos ?? [])
      .filter((info) => info.available && !info.master)
      .map((info) => ({
        id: info.recordTypeId,
        name: info.name,
        developerName: info.developerName,
      })),
    fields: describe.fields.map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      ...(field.custom ? { custom: true } : {}),
      ...(field.nillable === false &&
      field.createable &&
      !field.defaultedOnCreate &&
      field.type !== 'boolean'
        ? { required: true }
        : {}),
      ...(field.calculated || field.autoNumber || field.updateable === false
        ? { readOnly: true }
        : {}),
      ...(field.externalId ? { externalId: true } : {}),
      ...(field.nameField ? { nameField: true } : {}),
      ...(field.length && (field.type === 'string' || field.type === 'textarea')
        ? { length: field.length }
        : {}),
      ...(field.referenceTo?.length
        ? { referenceTo: field.referenceTo, relationshipName: field.relationshipName ?? undefined }
        : {}),
      ...(field.picklistValues?.length
        ? {
            values: field.picklistValues
              .filter((entry) => entry.active)
              .map((entry) => entry.value),
            ...(field.controllerName ? { controlledBy: field.controllerName } : {}),
          }
        : {}),
      ...(field.inlineHelpText ? { help: field.inlineHelpText } : {}),
    })),
    childRelationships: (describe.childRelationships ?? [])
      .filter((rel) => rel.relationshipName && !isSystemObject(rel.childSObject))
      .map((rel) => ({
        relationshipName: rel.relationshipName,
        childObject: rel.childSObject,
        field: rel.field,
        ...(rel.cascadeDelete ? { deletedWithParent: true } : {}),
      })),
  };
}

/** The field that names a record (Name, CaseNumber, Subject, an auto-number), or null. */
export function nameFieldOf(describe: DescribeSObject): DescribeField | null {
  return describe.fields.find((field) => field.nameField) ?? null;
}
