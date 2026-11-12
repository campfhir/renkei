/**
 * Permission sets: the rights an object access implies, and a new
 * permission set's metadata file. A new set deploys as metadata, with its
 * access inside it — nothing exists yet for a whole-set deploy to replace.
 * Access added to an existing set is written row by row as data instead
 * (apps/web lib/salesforce-admin/plan.ts), because deploying a set
 * replaces everything in it. Pure.
 */

import { developerNameOf, isDeveloperName } from './metadata';
import { metadataFile } from './metadata-xml';

export interface ObjectRights {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

/**
 * Rights with what each needs added, the way Setup ticks them: create and
 * edit need read; delete needs edit; view all needs read; modify all needs
 * everything else.
 */
export function impliedRights(rights: Partial<ObjectRights>): ObjectRights {
  const modifyAll = rights.modifyAll === true;
  const viewAll = modifyAll || rights.viewAll === true;
  const del = modifyAll || rights.delete === true;
  const edit = del || rights.edit === true;
  const create = modifyAll || rights.create === true;
  const read = edit || create || viewAll || rights.read === true;
  return { read, create, edit, delete: del, viewAll, modifyAll };
}

/** Rights in words: "read, create, edit". */
export function rightsLabel(rights: ObjectRights): string {
  return (
    [
      rights.read && 'read',
      rights.create && 'create',
      rights.edit && 'edit',
      rights.delete && 'delete',
      rights.viewAll && 'view all',
      rights.modifyAll && 'modify all',
    ]
      .filter(Boolean)
      .join(', ') || 'none'
  );
}

/** Each right either side has: access added never takes any away. */
export function unionRights(a: ObjectRights, b: ObjectRights): ObjectRights {
  return {
    read: a.read || b.read,
    create: a.create || b.create,
    edit: a.edit || b.edit,
    delete: a.delete || b.delete,
    viewAll: a.viewAll || b.viewAll,
    modifyAll: a.modifyAll || b.modifyAll,
  };
}

export interface NewPermissionSetSpec {
  name: string;
  label: string;
  description?: string;
  objects: ({ object: string } & ObjectRights)[];
  /** `Object.Field`. */
  fields: { field: string; edit: boolean }[];
  /** Tab names (a custom object's tab is its API name), shown in the app's navigation. */
  tabs: string[];
  /** Record types (`Object.RecordType`) people with the set can use. */
  recordTypes?: string[];
}

/** A new permission set's name and label, checked. */
export function checkPermissionSetName(
  input: { label?: string; name?: string },
  existing: readonly { name: string; label: string }[]
): { ok: true; name: string; label: string } | { ok: false; errors: string[] } {
  const label = (input.label ?? '').trim();
  const errors: string[] = [];
  if (!label || label.length > 80) errors.push('A permission set label is 1 to 80 characters.');
  const name = (input.name ?? '').trim() || developerNameOf(label, 80);
  const valid = isDeveloperName(name, 80);
  if (!valid) {
    errors.push(
      `"${name || label}" does not make a permission set API name: a letter first, then letters, digits and single underscores, 80 at most.`
    );
  } else if (existing.some((set) => set.name.toLowerCase() === name.toLowerCase())) {
    errors.push(`There is already a permission set ${name}.`);
  }
  if (existing.some((set) => set.label.toLowerCase() === label.toLowerCase())) {
    errors.push(`There is already a permission set labelled “${label}”.`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, name, label };
}

/** The `permissionsets/<name>.permissionset` file. */
export function permissionSetFile(spec: NewPermissionSetSpec): string {
  return metadataFile('PermissionSet', {
    description: spec.description ?? null,
    fieldPermissions: spec.fields.map((field) => ({
      editable: field.edit,
      field: field.field,
      readable: true,
    })),
    hasActivationRequired: false,
    label: spec.label,
    objectPermissions: spec.objects.map((entry) => ({
      allowCreate: entry.create,
      allowDelete: entry.delete,
      allowEdit: entry.edit,
      allowRead: entry.read,
      modifyAllRecords: entry.modifyAll,
      object: entry.object,
      viewAllRecords: entry.viewAll,
    })),
    recordTypeVisibilities: (spec.recordTypes ?? []).map((recordType) => ({
      recordType,
      visible: true,
    })),
    tabSettings: spec.tabs.map((tab) => ({ tab, visibility: 'Visible' })),
  });
}

/**
 * The rights left once some are taken away. A right goes with what it
 * stands on, the reverse of impliedRights: nothing without read, no delete
 * without edit, no modify all without every other right.
 */
export function withoutRights(
  now: ObjectRights,
  taken: readonly (keyof ObjectRights)[]
): ObjectRights {
  const next = { ...now };
  for (const right of taken) next[right] = false;
  if (!next.read) {
    return {
      read: false,
      create: false,
      edit: false,
      delete: false,
      viewAll: false,
      modifyAll: false,
    };
  }
  if (!next.edit) next.delete = false;
  if (!next.create || !next.edit || !next.delete || !next.viewAll) next.modifyAll = false;
  return next;
}

type Json = Record<string, unknown>;

const entries = (value: unknown): Json[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).filter(
    (entry): entry is Json => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  );

const named = (entry: Json, key: string, name: string): boolean =>
  typeof entry[key] === 'string' && entry[key].toLowerCase() === name.toLowerCase();

/** Access to write into a permission set's whole definition; `null` takes the entry out. */
export interface PermissionSetAccessChanges {
  /** `Object.Field` → what it may do, or null for no access. */
  fields?: { field: string; access: { read: boolean; edit: boolean } | null }[];
  objects?: { object: string; rights: ObjectRights | null }[];
  /** A tab by its name (a custom object's API name), shown or not. */
  tabs?: { tab: string; shown: boolean }[];
  /** Record types to make usable, as `Object.RecordType`. */
  recordTypes?: string[];
}

/**
 * A permission set's whole definition (as readMetadata gives it) with
 * access changed in place: for the sets Salesforce will not take a row at
 * a time — one in a permission set group — and for what has no row
 * (record types). Everything not named stays exactly as read. Pure.
 */
export function mergePermissionSetAccess(
  metadata: Json,
  changes: PermissionSetAccessChanges
): Json {
  const next: Json = { ...metadata };
  if (changes.fields?.length) {
    let fields = entries(metadata.fieldPermissions);
    for (const { field, access } of changes.fields) {
      fields = fields.filter((entry) => !named(entry, 'field', field));
      if (access && (access.read || access.edit)) {
        fields.push({ editable: access.edit, field, readable: true });
      }
    }
    next.fieldPermissions = fields;
  }
  if (changes.objects?.length) {
    let objects = entries(metadata.objectPermissions);
    for (const { object, rights } of changes.objects) {
      objects = objects.filter((entry) => !named(entry, 'object', object));
      if (rights?.read) {
        objects.push({
          allowCreate: rights.create,
          allowDelete: rights.delete,
          allowEdit: rights.edit,
          allowRead: true,
          modifyAllRecords: rights.modifyAll,
          object,
          viewAllRecords: rights.viewAll,
        });
      }
    }
    next.objectPermissions = objects;
  }
  if (changes.tabs?.length) {
    let tabs = entries(metadata.tabSettings);
    for (const { tab, shown } of changes.tabs) {
      tabs = tabs.filter((entry) => !named(entry, 'tab', tab));
      if (shown) tabs.push({ tab, visibility: 'Visible' });
    }
    next.tabSettings = tabs;
  }
  if (changes.recordTypes?.length) {
    let visible = entries(metadata.recordTypeVisibilities);
    for (const recordType of changes.recordTypes) {
      visible = visible.filter((entry) => !named(entry, 'recordType', recordType));
      visible.push({ recordType, visible: true });
    }
    next.recordTypeVisibilities = visible;
  }
  return next;
}

/** How many field and object entries of a set's whole definition grant something. */
export function permissionSetGrantCounts(metadata: Json): { fields: number; objects: number } {
  const on = (value: unknown) => value === true || value === 'true';
  return {
    fields: entries(metadata.fieldPermissions).filter(
      (entry) => on(entry.readable) || on(entry.editable)
    ).length,
    objects: entries(metadata.objectPermissions).filter((entry) => on(entry.allowRead)).length,
  };
}
