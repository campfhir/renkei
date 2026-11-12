/**
 * What a change request holds, and what has to still be true when it is
 * applied.
 *
 * A proposal stores the exact deployment — `files` (the manifest and the
 * component files) and `members`; empty for a change that is data only —
 * beside a readable `components` list for the review page, the
 * `preconditions` it was built on, and `dataSteps`: what runs after the
 * deploy succeeds, as data rather than metadata — field and object access
 * in permission sets, tab visibility, and permission set assignments. Access is data
 * (FieldPermissions, ObjectPermissions) because a permission set deployed
 * as metadata replaces itself whole and would drop everything the package
 * did not list; each step reads the live row when it runs and updates it
 * or inserts one.
 *
 * Preconditions are re-read live on apply, and any that no longer holds
 * stops the apply before anything deploys: a field or object someone else
 * created in the meantime, a rule, field or layout edited since it was read
 * (by a hash of its metadata), a permission set created under the name.
 */

import { soqlString, type PackageMember } from '@renkei/connector-salesforce';
import {
  rec,
  recs,
  sfQuery,
  sfRequest,
  str,
  type SalesforceAccess,
  type SalesforceCallContext,
  type SalesforceResult,
} from '@/lib/mcp-tools/salesforce/client';
import { entityKey, fingerprintOf, toolingQuery } from './tooling';
import { listRecordTypes, wholeComponentFingerprint } from './whole-components';

export { entityKey, fingerprintOf, toolingQuery } from './tooling';

export const FIELDS_KIND = 'fields';
export const VALIDATION_RULE_KIND = 'validation_rule';
export const FIELD_CHANGES_KIND = 'field_changes';
export const PICKLIST_CHANGES_KIND = 'picklist_changes';
export const LAYOUT_KIND = 'layout';
export const OBJECT_KIND = 'object';
export const PERMISSION_SET_KIND = 'permission_set';
export const ASSIGNMENTS_KIND = 'assignments';
export const RECORD_TYPE_KIND = 'record_type';
export const REPORT_TYPE_KIND = 'report_type';
export const REPORT_KIND = 'report';
/** System permissions, a profile's login hours and IP ranges, a new profile. */
export const SECURITY_KIND = 'security';

/**
 * The capabilities applying a change stands on (lib/salesforce-admin-scopes.ts):
 * its kind's, and those of what else it carries — a layout placed in a
 * fields proposal needs the layouts capability too, an assignment the
 * user-access one.
 */
export function applyScopesFor(kind: string, payload?: MetadataPayload | null): string[] {
  const scopes = new Set<string>();
  switch (kind) {
    case LAYOUT_KIND:
      scopes.add('sfa-layouts');
      break;
    case PERMISSION_SET_KIND:
      scopes.add('sfa-permissions');
      break;
    case ASSIGNMENTS_KIND:
      scopes.add('sfa-user-access');
      break;
    case SECURITY_KIND:
      scopes.add('sfa-security');
      break;
    default:
      scopes.add('sfa-schema');
  }
  if (payload?.members.some((member) => member.type === 'Layout')) scopes.add('sfa-layouts');
  // Record type visibility in a profile is access.
  if (payload?.members.some((member) => member.type === 'Profile')) scopes.add('sfa-permissions');
  if (payload?.dataSteps.some((step) => step.kind === 'system-permission')) {
    scopes.add('sfa-security');
  }
  if (payload?.dataSteps.some((step) => step.kind === 'assign' || step.kind === 'unassign')) {
    scopes.add('sfa-user-access');
  }
  return [...scopes];
}

/** One line of a component on the review page: a value, or old → new. */
export interface ViewRow {
  label: string;
  value: string;
  from?: string;
}

export interface ComponentView {
  /** CustomField, ValidationRule, Layout, CustomObject, CustomTab, PermissionSet… */
  type: string;
  /** `Object.Member`, a layout's full name, an object's API name. */
  name: string;
  /** 'delete' takes the component out of the org (a destructive deploy). */
  action: 'create' | 'update' | 'delete';
  rows: ViewRow[];
}

export type Precondition =
  | { kind: 'field-absent'; object: string; field: string }
  | { kind: 'rule-absent'; object: string; rule: string }
  | { kind: 'rule-unchanged'; object: string; rule: string; fingerprint: string }
  | { kind: 'field-unchanged'; object: string; field: string; fingerprint: string }
  | { kind: 'layout-unchanged'; object: string; layout: string; fingerprint: string }
  | { kind: 'layout-absent'; object: string; layout: string }
  | { kind: 'object-absent'; object: string }
  | { kind: 'record-type-absent'; object: string; name: string }
  | {
      kind: 'component-unchanged';
      type: WholeComponent;
      /** The object (record types, processes, a standard set's field). */
      object: string;
      /** The record type's developer name, the process's or global set's name, a standard set's field. */
      name: string;
      fingerprint: string;
    }
  | { kind: 'permission-set-absent'; name: string }
  | { kind: 'profile-absent'; name: string }
  /** A custom report type's developer name, without `__c`. */
  | { kind: 'report-type-absent'; name: string }
  | { kind: 'report-folder-absent'; folder: string }
  /** A report's developer name in a folder (by the folder's developer name). */
  | { kind: 'report-absent'; folder: string; name: string };

/** Components read whole and written back whole, checked by a hash on apply. */
export type WholeComponent =
  | 'RecordType'
  | 'BusinessProcess'
  | 'GlobalValueSet'
  | 'StandardValueSet'
  | 'ReportType'
  | 'Report'
  | 'PermissionSet'
  | 'Profile';

const WHOLE_COMPONENTS: readonly WholeComponent[] = [
  'RecordType',
  'BusinessProcess',
  'GlobalValueSet',
  'StandardValueSet',
  'ReportType',
  'Report',
  'PermissionSet',
  'Profile',
];

export interface Access {
  read: boolean;
  edit: boolean;
}

export interface ObjectAccess {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

export type DataStep =
  | ({
      kind: 'field-permission';
      permissionSetId: string;
      permissionSetName: string;
      object: string;
      /** The field's API name, without the object. */
      field: string;
      /**
       * Set when the step takes access away, which a grant never does:
       * 'all' leaves none, 'edit' leaves read. A step without it only adds.
       */
      remove?: 'all' | 'edit';
    } & Access)
  | ({
      kind: 'object-permission';
      permissionSetId: string;
      permissionSetName: string;
      object: string;
      /**
       * Set when the step takes rights away: the rights given are what is
       * left (none of them: the row goes). A step without it only adds.
       */
      remove?: true;
    } & ObjectAccess)
  | {
      kind: 'tab-visibility';
      permissionSetId: string;
      permissionSetName: string;
      /** The tab's name: a custom object's API name for its tab. */
      tab: string;
      /** DefaultOn: in the app's navigation; DefaultOff: on All Tabs only. */
      visibility: 'DefaultOn' | 'DefaultOff';
      /** Set when the step stops showing the tab instead. */
      remove?: true;
    }
  | {
      /** An app the set or profile may open (a SetupEntityAccess row), or no longer may. */
      kind: 'app-visibility';
      permissionSetId: string;
      permissionSetName: string;
      /** The app's id (AppDefinition.DurableId). */
      appId: string;
      app: string;
      remove?: true;
    }
  | {
      /** A permission set's label or description. */
      kind: 'permission-set-details';
      permissionSetId: string;
      permissionSetName: string;
      label?: string;
      description?: string;
    }
  | {
      kind: 'permission-set-delete';
      permissionSetId: string;
      permissionSetName: string;
    }
  | {
      /** A system permission (Permissions… on the set's or profile's own row) turned on or off. */
      kind: 'system-permission';
      permissionSetId: string;
      permissionSetName: string;
      /** The row that carries it: the permission set's, or the profile's. */
      target: 'PermissionSet' | 'Profile';
      targetId: string;
      /** The field's API name: PermissionsViewSetup. */
      permission: string;
      label: string;
      enabled: boolean;
    }
  | {
      kind: 'assign';
      permissionSetId: string;
      permissionSetName: string;
      userId: string;
      userName: string;
    }
  | {
      kind: 'unassign';
      permissionSetId: string;
      permissionSetName: string;
      userId: string;
      userName: string;
    };

export interface MetadataPayload {
  /** Empty for a change that is data only (assignments, access on an existing set). */
  files: Record<string, string>;
  members: PackageMember[];
  components: ComponentView[];
  preconditions: Precondition[];
  dataSteps: DataStep[];
}

/** Whether a payload deploys anything, or is data steps alone. */
export function deploys(payload: MetadataPayload): boolean {
  return Boolean(payload.files['package.xml']) && payload.members.length > 0;
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rec(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

const flag = (value: unknown): boolean => value === true;

function stepOf(raw: Record<string, unknown>): DataStep | null {
  const base = {
    permissionSetId: str(raw.permissionSetId),
    permissionSetName: str(raw.permissionSetName),
  };
  switch (raw.kind) {
    case 'field-permission':
      return {
        kind: 'field-permission',
        ...base,
        object: str(raw.object),
        field: str(raw.field),
        read: raw.read !== false,
        edit: flag(raw.edit),
        ...(raw.remove === 'all' || raw.remove === 'edit' ? { remove: raw.remove } : {}),
      };
    case 'object-permission':
      return {
        kind: 'object-permission',
        ...base,
        object: str(raw.object),
        read: flag(raw.read),
        create: flag(raw.create),
        edit: flag(raw.edit),
        delete: flag(raw.delete),
        viewAll: flag(raw.viewAll),
        modifyAll: flag(raw.modifyAll),
        ...(raw.remove === true ? { remove: true as const } : {}),
      };
    case 'tab-visibility':
      return {
        kind: 'tab-visibility',
        ...base,
        tab: str(raw.tab),
        visibility: raw.visibility === 'DefaultOff' ? 'DefaultOff' : 'DefaultOn',
        ...(raw.remove === true ? { remove: true as const } : {}),
      };
    case 'app-visibility':
      return {
        kind: 'app-visibility',
        ...base,
        appId: str(raw.appId),
        app: str(raw.app),
        ...(raw.remove === true ? { remove: true as const } : {}),
      };
    case 'permission-set-details':
      return {
        kind: 'permission-set-details',
        ...base,
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      };
    case 'permission-set-delete':
      return { kind: 'permission-set-delete', ...base };
    case 'system-permission':
      // Only a Permissions… field is ever written from a stored step.
      return /^Permissions[A-Za-z0-9]+$/.test(str(raw.permission))
        ? {
            kind: 'system-permission',
            ...base,
            target: raw.target === 'Profile' ? 'Profile' : 'PermissionSet',
            targetId: str(raw.targetId),
            permission: str(raw.permission),
            label: str(raw.label),
            enabled: raw.enabled === true,
          }
        : null;
    case 'assign':
    case 'unassign':
      return { kind: raw.kind, ...base, userId: str(raw.userId), userName: str(raw.userName) };
    default:
      return null;
  }
}

/** A stored payload, defensively; null when it is not one this code can apply. */
export function readMetadataPayload(value: unknown): MetadataPayload | null {
  const entry = rec(value);
  const files = stringMap(entry.files);
  const members = recs(entry.members).flatMap((m) =>
    typeof m.type === 'string' && typeof m.member === 'string'
      ? [{ type: m.type, member: m.member }]
      : []
  );
  const components = recs(entry.components).map((c) => ({
    type: str(c.type),
    name: str(c.name),
    action:
      c.action === 'update'
        ? ('update' as const)
        : c.action === 'delete'
          ? ('delete' as const)
          : ('create' as const),
    rows: recs(c.rows).map((row) => ({
      label: str(row.label),
      value: str(row.value),
      ...(typeof row.from === 'string' ? { from: row.from } : {}),
    })),
  }));
  const preconditions = recs(entry.preconditions).flatMap((p): Precondition[] => {
    const object = str(p.object);
    const fingerprint = str(p.fingerprint);
    switch (p.kind) {
      case 'field-absent':
        return [{ kind: 'field-absent', object, field: str(p.field) }];
      case 'rule-absent':
        return [{ kind: 'rule-absent', object, rule: str(p.rule) }];
      case 'rule-unchanged':
        return [{ kind: 'rule-unchanged', object, rule: str(p.rule), fingerprint }];
      case 'field-unchanged':
        return [{ kind: 'field-unchanged', object, field: str(p.field), fingerprint }];
      case 'layout-unchanged':
        return [{ kind: 'layout-unchanged', object, layout: str(p.layout), fingerprint }];
      case 'layout-absent':
        return [{ kind: 'layout-absent', object, layout: str(p.layout) }];
      case 'object-absent':
        return [{ kind: 'object-absent', object }];
      case 'record-type-absent':
        return [{ kind: 'record-type-absent', object, name: str(p.name) }];
      case 'component-unchanged': {
        const type = WHOLE_COMPONENTS.find((t) => t === p.type);
        return type
          ? [{ kind: 'component-unchanged', type, object, name: str(p.name), fingerprint }]
          : [];
      }
      case 'permission-set-absent':
        return [{ kind: 'permission-set-absent', name: str(p.name) }];
      case 'profile-absent':
        return [{ kind: 'profile-absent', name: str(p.name) }];
      case 'report-type-absent':
        return [{ kind: 'report-type-absent', name: str(p.name) }];
      case 'report-folder-absent':
        return [{ kind: 'report-folder-absent', folder: str(p.folder) }];
      case 'report-absent':
        return [{ kind: 'report-absent', folder: str(p.folder), name: str(p.name) }];
      default:
        return [];
    }
  });
  const dataSteps = recs(entry.dataSteps).flatMap((raw) => {
    const step = stepOf(raw);
    return step ? [step] : [];
  });
  // The first version's field grants, stored before data steps existed.
  for (const grant of recs(entry.fieldGrants)) {
    dataSteps.push({
      kind: 'field-permission',
      permissionSetId: str(grant.permissionSetId),
      permissionSetName: str(grant.permissionSetName),
      object: str(grant.object),
      field: str(grant.field),
      read: true,
      edit: grant.edit === true,
    });
  }
  const payload = { files, members, components, preconditions, dataSteps };
  return deploys(payload) || dataSteps.length > 0 ? payload : null;
}

/** What a data step does, in words. */
export function stepLabel(step: DataStep): string {
  switch (step.kind) {
    case 'field-permission':
      if (step.remove === 'all')
        return `Take ${step.permissionSetName}’s access to ${step.object}.${step.field} away`;
      if (step.remove === 'edit')
        return `Leave ${step.permissionSetName} read-only access to ${step.object}.${step.field}`;
      return `Give ${step.permissionSetName} ${step.edit ? 'read and edit' : 'read'} access to ${step.object}.${step.field}`;
    case 'object-permission': {
      const rights = [
        step.read && 'read',
        step.create && 'create',
        step.edit && 'edit',
        step.delete && 'delete',
        step.viewAll && 'view all',
        step.modifyAll && 'modify all',
      ].filter(Boolean);
      if (step.remove) {
        return rights.length > 0
          ? `Leave ${step.permissionSetName} only ${rights.join(', ')} access to ${step.object} records`
          : `Take ${step.permissionSetName}’s access to ${step.object} records away`;
      }
      return `Give ${step.permissionSetName} ${rights.join(', ') || 'no'} access to ${step.object} records`;
    }
    case 'tab-visibility':
      if (step.remove) return `Stop showing the ${step.tab} tab to ${step.permissionSetName}`;
      return `Show the ${step.tab} tab to ${step.permissionSetName}${step.visibility === 'DefaultOn' ? ' (in their navigation by default)' : ''}`;
    case 'app-visibility':
      return step.remove
        ? `Stop ${step.permissionSetName} opening the app ${step.app}`
        : `Let ${step.permissionSetName} open the app ${step.app}`;
    case 'permission-set-details':
      return [
        step.label !== undefined && `Rename ${step.permissionSetName} to “${step.label}”`,
        step.description !== undefined &&
          `${step.label !== undefined ? 'and describe it' : `Describe ${step.permissionSetName}`} as “${step.description}”`,
      ]
        .filter(Boolean)
        .join(' ');
    case 'permission-set-delete':
      return `Delete the permission set ${step.permissionSetName}`;
    case 'system-permission':
      return step.enabled
        ? `Give ${step.permissionSetName} the system permission “${step.label}”`
        : `Take the system permission “${step.label}” away from ${step.permissionSetName}`;
    case 'assign':
      return `Assign ${step.permissionSetName} to ${step.userName}`;
    case 'unassign':
      return `Remove ${step.permissionSetName} from ${step.userName}`;
  }
}

/** Whether a field exists on an object, whoever can see it (FieldDefinition, not the describe). */
export async function fieldExists(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  field: string
): Promise<boolean | string> {
  const found = await sfQuery(
    context,
    access,
    `SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ${soqlString(object)} AND QualifiedApiName = ${soqlString(field)}`
  );
  if (!found.ok) return found.error;
  if (found.records.length > 0) return true;
  // FieldDefinition can leave out a custom field the person has no
  // field-level access to (one deployed a moment ago with no permission set
  // given access). The Tooling API's CustomField lists it whoever sees it.
  if (!/__c$/i.test(field)) return false;
  const hidden = await readCustomField(context, access, object, field);
  return typeof hidden === 'object' && hidden !== null;
}

/**
 * Whether the Reports API's answer for one report type says there is no
 * such type. Salesforce answers 400 BAD_REQUEST ("Specify a valid report
 * type. X__c is not a report type.") rather than 404 for a name that names
 * nothing, so both mean absent; any other failure is a failure.
 */
export function isMissingReportType(result: SalesforceResult): boolean {
  if (result.ok) return false;
  if (result.status === 404) return true;
  return (
    result.status === 400 &&
    result.errors.some(
      (error) =>
        error.errorCode === 'BAD_REQUEST' && /not a (valid )?report type/i.test(error.message)
    )
  );
}

/** Whether a custom report type exists (its developer name, with or without `__c`). */
export async function reportTypeExists(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  name: string
): Promise<boolean | string> {
  const type = `${name.replace(/__c$/i, '')}__c`;
  const found = await sfRequest(
    context,
    access,
    'GET',
    `/analytics/reportTypes/${encodeURIComponent(type)}`
  );
  if (found.ok) return true;
  return isMissingReportType(found) ? false : found.error;
}

export interface ReportFolder {
  id: string;
  name: string;
  developerName: string;
  accessType: string;
}

/** The org's report folders the person can see, by name (private ones are not folders here). */
export async function listReportFolders(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  match?: string
): Promise<ReportFolder[] | string> {
  const where = match
    ? ` AND (DeveloperName = ${soqlString(match)} OR Name = ${soqlString(match)})`
    : ` AND DeveloperName != null`;
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, DeveloperName, AccessType FROM Folder WHERE Type = 'Report'${where} ORDER BY Name LIMIT 200`
  );
  if (!found.ok) return found.error;
  return found.records.map((row) => ({
    id: str(row.Id),
    name: str(row.Name),
    developerName: str(row.DeveloperName),
    accessType: str(row.AccessType),
  }));
}

export interface ReportRef {
  id: string;
  name: string;
  developerName: string;
  /** The folder it is in: its name, and its developer name for a deploy. */
  folder: ReportFolder;
}

/**
 * The reports of this name or API name in the org's report folders,
 * optionally in one folder (by its name or API name). A report in a
 * person's private folder or in Unfiled Public Reports is in none of them.
 */
export async function findReports(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  report: string,
  folder?: string
): Promise<ReportRef[] | string> {
  const folders = await listReportFolders(context, access, folder);
  if (typeof folders === 'string') return folders;
  if (folders.length === 0) return [];
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, DeveloperName, OwnerId FROM Report WHERE DeveloperName = ${soqlString(report)} OR Name = ${soqlString(report)} ORDER BY Name LIMIT 50`
  );
  if (!found.ok) return found.error;
  return found.records.flatMap((row) => {
    const home = folders.find((f) => f.id === str(row.OwnerId));
    return home
      ? [
          {
            id: str(row.Id),
            name: str(row.Name),
            developerName: str(row.DeveloperName),
            folder: home,
          },
        ]
      : [];
  });
}

/** Whether a report of this developer name is in the folder. */
export async function reportExists(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  folder: string,
  name: string
): Promise<boolean | string> {
  const folders = await listReportFolders(context, access, folder);
  if (typeof folders === 'string') return folders;
  const match = folders.find((f) => f.developerName.toLowerCase() === folder.toLowerCase());
  if (!match) return false;
  const found = await sfQuery(
    context,
    access,
    `SELECT Id FROM Report WHERE OwnerId = ${soqlString(match.id)} AND DeveloperName = ${soqlString(name)} LIMIT 1`
  );
  if (!found.ok) return found.error;
  return found.records.length > 0;
}

/** Whether an object exists in the org, whoever can see it. */
export async function objectExists(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string
): Promise<boolean | string> {
  const found = await sfQuery(
    context,
    access,
    `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = ${soqlString(object)} LIMIT 1`
  );
  if (!found.ok) return found.error;
  return found.records.length > 0;
}

export interface LiveRule {
  id: string;
  name: string;
  active: boolean;
  description: string;
  formula: string;
  message: string;
  errorDisplayField: string;
  fingerprint: string;
}

/** One validation rule with its formula, from the Tooling API (Metadata needs a one-row query). */
export async function readValidationRule(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  rule: string
): Promise<LiveRule | null | string> {
  const found = await toolingQuery(
    context,
    access,
    `SELECT Id, ValidationName, Active, Description, ErrorMessage, ErrorDisplayField, Metadata FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = ${soqlString(object)} AND ValidationName = ${soqlString(rule)} LIMIT 1`
  );
  if (!found.ok) return found.error;
  const row = found.records[0];
  if (!row) return null;
  const metadata = rec(row.Metadata);
  return {
    id: str(row.Id),
    name: str(row.ValidationName),
    active: row.Active === true,
    description: str(row.Description),
    formula: str(metadata.errorConditionFormula),
    message: str(row.ErrorMessage) || str(metadata.errorMessage),
    errorDisplayField: str(row.ErrorDisplayField) || str(metadata.errorDisplayField),
    fingerprint: fingerprintOf(metadata),
  };
}

export interface LiveCustomField {
  id: string;
  /** `Object.Field__c`. */
  fullName: string;
  metadata: Record<string, unknown>;
  fingerprint: string;
}

/** A custom field's whole definition, from the Tooling API. */
export async function readCustomField(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  field: string
): Promise<LiveCustomField | null | string> {
  if (!/__c$/i.test(field)) {
    return `${field} is a standard field; this changes custom fields (…__c) only.`;
  }
  const table = await entityKey(context, access, object);
  if (!table) return `There is no object ${object}.`;
  const found = await toolingQuery(
    context,
    access,
    `SELECT Id, FullName, Metadata FROM CustomField WHERE TableEnumOrId = ${soqlString(table)} AND DeveloperName = ${soqlString(field.replace(/__c$/i, ''))} LIMIT 1`
  );
  if (!found.ok) return found.error;
  const row = found.records[0];
  if (!row) return null;
  const metadata = rec(row.Metadata);
  return {
    id: str(row.Id),
    fullName: str(row.FullName) || `${object}.${field}`,
    metadata,
    fingerprint: fingerprintOf(metadata),
  };
}

export interface LayoutRef {
  id: string;
  name: string;
}

/** An object's page layouts, by name. */
export async function listLayouts(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string
): Promise<LayoutRef[] | string> {
  const table = await entityKey(context, access, object);
  if (!table) return `There is no object ${object}.`;
  const found = await toolingQuery(
    context,
    access,
    `SELECT Id, Name FROM Layout WHERE TableEnumOrId = ${soqlString(table)} ORDER BY Name`
  );
  if (!found.ok) return found.error;
  return found.records.map((row) => ({ id: str(row.Id), name: str(row.Name) }));
}

export interface LiveLayout {
  id: string;
  name: string;
  /** `Object-Layout Name`, the member name a deploy uses. */
  fullName: string;
  metadata: Record<string, unknown>;
  fingerprint: string;
}

/** One layout, whole, by its name (or the object's only layout when it has one). */
export async function readLayout(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  name: string | undefined
): Promise<LiveLayout | string> {
  const layouts = await listLayouts(context, access, object);
  if (typeof layouts === 'string') return layouts;
  const wanted = name?.trim().toLowerCase();
  const match = wanted
    ? layouts.find((layout) => layout.name.toLowerCase() === wanted)
    : layouts.length === 1
      ? layouts[0]
      : undefined;
  if (!match) {
    return layouts.length === 0
      ? `${object} has no page layouts.`
      : `Name the layout: ${object}’s layouts are ${layouts.map((l) => `“${l.name}”`).join(', ')}.`;
  }
  const found = await toolingQuery(
    context,
    access,
    `SELECT Id, Name, FullName, Metadata FROM Layout WHERE Id = ${soqlString(match.id)} LIMIT 1`
  );
  if (!found.ok) return found.error;
  const row = found.records[0];
  if (!row) return `The layout “${match.name}” is gone.`;
  const metadata = rec(row.Metadata);
  return {
    id: match.id,
    name: match.name,
    fullName: str(row.FullName) || `${object}-${match.name}`,
    metadata,
    fingerprint: fingerprintOf(metadata),
  };
}

/** The preconditions that no longer hold, in words; empty when the change may go ahead. */
export async function brokenPreconditions(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  preconditions: readonly Precondition[]
): Promise<string[]> {
  const broken: string[] = [];
  const moved = (what: string) =>
    broken.push(`${what} was changed since this was proposed; propose again from what it is now.`);
  for (const precondition of preconditions) {
    switch (precondition.kind) {
      case 'field-absent': {
        const name = `${precondition.object}.${precondition.field}`;
        const exists = await fieldExists(context, access, precondition.object, precondition.field);
        if (typeof exists === 'string') broken.push(`Could not check ${name}: ${exists}`);
        else if (exists)
          broken.push(`${name} exists now — someone created it since this was proposed.`);
        break;
      }
      case 'object-absent': {
        const exists = await objectExists(context, access, precondition.object);
        if (typeof exists === 'string')
          broken.push(`Could not check ${precondition.object}: ${exists}`);
        else if (exists) {
          broken.push(
            `${precondition.object} exists now — someone created it since this was proposed.`
          );
        }
        break;
      }
      case 'permission-set-absent': {
        const found = await sfQuery(
          context,
          access,
          `SELECT Id FROM PermissionSet WHERE Name = ${soqlString(precondition.name)} LIMIT 1`
        );
        if (!found.ok)
          broken.push(`Could not check the permission set ${precondition.name}: ${found.error}`);
        else if (found.records.length > 0) {
          broken.push(
            `A permission set ${precondition.name} exists now — someone created it since this was proposed.`
          );
        }
        break;
      }
      case 'report-type-absent': {
        const name = `The report type ${precondition.name}__c`;
        const exists = await reportTypeExists(context, access, precondition.name);
        if (typeof exists === 'string') broken.push(`Could not check ${name}: ${exists}`);
        else if (exists)
          broken.push(`${name} exists now — someone created it since this was proposed.`);
        break;
      }
      case 'report-folder-absent': {
        const name = `The report folder ${precondition.folder}`;
        const folders = await listReportFolders(context, access, precondition.folder);
        if (typeof folders === 'string') broken.push(`Could not check ${name}: ${folders}`);
        else if (
          folders.some((f) => f.developerName.toLowerCase() === precondition.folder.toLowerCase())
        )
          broken.push(`${name} exists now — someone created it since this was proposed.`);
        break;
      }
      case 'report-absent': {
        const name = `The report ${precondition.folder}/${precondition.name}`;
        const exists = await reportExists(context, access, precondition.folder, precondition.name);
        if (typeof exists === 'string') broken.push(`Could not check ${name}: ${exists}`);
        else if (exists)
          broken.push(`${name} exists now — someone created it since this was proposed.`);
        break;
      }
      case 'rule-absent':
      case 'rule-unchanged': {
        const name = `The rule ${precondition.object}.${precondition.rule}`;
        const live = await readValidationRule(
          context,
          access,
          precondition.object,
          precondition.rule
        );
        if (typeof live === 'string') broken.push(`Could not check ${name}: ${live}`);
        else if (precondition.kind === 'rule-absent' && live) {
          broken.push(`${name} exists now — someone created it since this was proposed.`);
        } else if (precondition.kind === 'rule-unchanged') {
          if (!live) broken.push(`${name} is gone — someone deleted it since this was proposed.`);
          else if (live.fingerprint !== precondition.fingerprint) moved(name);
        }
        break;
      }
      case 'field-unchanged': {
        const name = `${precondition.object}.${precondition.field}`;
        const live = await readCustomField(
          context,
          access,
          precondition.object,
          precondition.field
        );
        if (typeof live === 'string') broken.push(`Could not check ${name}: ${live}`);
        else if (!live)
          broken.push(`${name} is gone — someone deleted it since this was proposed.`);
        else if (live.fingerprint !== precondition.fingerprint) moved(name);
        break;
      }
      case 'record-type-absent': {
        const types = await listRecordTypes(context, access, precondition.object);
        if (typeof types === 'string')
          broken.push(`Could not check the record types of ${precondition.object}: ${types}`);
        else if (
          types.some((rt) => rt.developerName.toLowerCase() === precondition.name.toLowerCase())
        )
          broken.push(
            `The record type ${precondition.object}.${precondition.name} exists now — someone created it since this was proposed.`
          );
        break;
      }
      case 'component-unchanged': {
        const label =
          precondition.type === 'StandardValueSet'
            ? `The values of ${precondition.object}.${precondition.name}`
            : precondition.type === 'GlobalValueSet'
              ? `The global value set ${precondition.name}`
              : precondition.type === 'ReportType'
                ? `The report type ${precondition.name}__c`
                : precondition.type === 'Report'
                  ? `The report ${precondition.name}`
                  : `The ${precondition.type === 'RecordType' ? 'record type' : 'process'} ${precondition.object}.${precondition.name}`;
        const now = await wholeComponentFingerprint(context, access, precondition);
        if (now && typeof now === 'object') broken.push(`Could not check ${label}: ${now.error}`);
        else if (now === null)
          broken.push(`${label} is gone — someone deleted it since this was proposed.`);
        else if (now !== precondition.fingerprint) moved(label);
        break;
      }
      case 'layout-unchanged': {
        const name = `The layout “${precondition.layout}”`;
        const live = await readLayout(context, access, precondition.object, precondition.layout);
        if (typeof live === 'string') broken.push(`Could not check ${name}: ${live}`);
        else if (live.fingerprint !== precondition.fingerprint) moved(name);
        break;
      }
      case 'profile-absent': {
        const found = await sfQuery(
          context,
          access,
          `SELECT Id FROM Profile WHERE Name = ${soqlString(precondition.name)} LIMIT 1`
        );
        if (!found.ok)
          broken.push(`Could not check the profile ${precondition.name}: ${found.error}`);
        else if (found.records.length > 0) {
          broken.push(
            `The profile ${precondition.name} exists now — someone created it since this was proposed.`
          );
        }
        break;
      }
      case 'layout-absent': {
        const layouts = await listLayouts(context, access, precondition.object);
        if (typeof layouts === 'string') {
          broken.push(`Could not check the layout “${precondition.layout}”: ${layouts}`);
        } else if (
          layouts.some((l) => l.name.toLowerCase() === precondition.layout.toLowerCase())
        ) {
          broken.push(
            `The layout “${precondition.layout}” exists now — someone created it since this was proposed.`
          );
        }
        break;
      }
    }
  }
  return broken;
}

/** A permission set group, as the tools name one: its label and the sets it is made of. */
export interface PermissionSetGroupInfo {
  id: string;
  label: string;
  /** The sets in it, by API name and label. */
  sets: { name: string; label: string }[];
}

/** Why a permission set group cannot take a change, and what can: the sets in it. */
export function groupRefusal(name: string, group: PermissionSetGroupInfo): string {
  const sets = group.sets.map((set) => `${set.label} (${set.name})`);
  return (
    `${name} is a permission set group${group.label && group.label !== name ? ` (“${group.label}”)` : ''}, not a permission set: ` +
    'Salesforce works out what a group grants from the permission sets in it, and refuses a change made to the group itself. ' +
    (sets.length > 0
      ? `Make the change in one of its sets, and everyone with the group gets it: ${sets.join(', ')}.`
      : 'It has no permission sets in it yet: add one to the group in Setup, and make the change in that set.')
  );
}

/**
 * A permission set by API name or label.
 *
 * A permission set group has a permission set row of its own, under the
 * group's name, holding what the group grants in total. Salesforce derives
 * it from the sets in the group and refuses any write to it ("its parent
 * is associated with a permission set group"). It reads as a permission
 * set, so it is told apart here: a caller that changes access gets the
 * refusal naming the group's sets; a caller that only reads asks for it
 * with `group: 'read'` and gets the group beside the row.
 */
export async function resolvePermissionSet(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  ref: string,
  options: { group?: 'read' } = {}
): Promise<{ id: string; name: string; group?: PermissionSetGroupInfo } | string> {
  const literal = soqlString(ref.trim());
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, Label, Type, PermissionSetGroupId FROM PermissionSet WHERE IsOwnedByProfile = false AND (Name = ${literal} OR Label = ${literal}) LIMIT 3`
  );
  if (!found.ok) return found.error;
  if (found.records.length > 1) {
    return `"${ref}" names more than one permission set: ${found.records.map((r) => str(r.Name)).join(', ')}. Use the API name.`;
  }
  const row = found.records[0];
  if (!row) {
    return `No permission set "${ref}" in this org (a profile is named as profile, not permissionSet).`;
  }
  const set = { id: str(row.Id), name: str(row.Name) };
  const groupId = str(row.PermissionSetGroupId);
  if (!groupId && str(row.Type) !== 'Group') return set;

  const members = groupId
    ? await sfQuery(
        context,
        access,
        `SELECT PermissionSet.Name, PermissionSet.Label FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = ${soqlString(groupId)} LIMIT 100`
      )
    : null;
  const group: PermissionSetGroupInfo = {
    id: groupId,
    label: str(row.Label),
    sets: members?.ok
      ? members.records
          .map((member) => rec(member.PermissionSet))
          .filter((member) => str(member.Name))
          .map((member) => ({
            name: str(member.Name),
            label: str(member.Label) || str(member.Name),
          }))
      : [],
  };
  return options.group === 'read' ? { ...set, group } : groupRefusal(set.name, group);
}

/**
 * A profile's own permission set: the row its field, object and tab access
 * hang from (`IsOwnedByProfile`), so access in a profile is read and written
 * exactly as a permission set's is. Named in steps as "the profile X".
 */
export async function resolveProfileAccess(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  ref: string
): Promise<{ id: string; name: string; profile: string; profileId: string } | string> {
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, ProfileId, Profile.Name FROM PermissionSet WHERE IsOwnedByProfile = true AND Profile.Name = ${soqlString(ref.trim())} LIMIT 2`
  );
  if (!found.ok) return found.error;
  if (found.records.length !== 1) return `No profile "${ref}" in this org.`;
  const profile = str(rec(found.records[0].Profile).Name) || ref.trim();
  return {
    id: str(found.records[0].Id),
    name: `the profile ${profile}`,
    profile,
    profileId: str(found.records[0].ProfileId),
  };
}

/** Who a grant names: a permission set, or a profile (through its own permission set). */
export async function resolveAccessHolder(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  holder: { permissionSet?: string; profile?: string }
): Promise<{ id: string; name: string } | string> {
  const set = holder.permissionSet?.trim();
  const profile = holder.profile?.trim();
  if (Boolean(set) === Boolean(profile)) return 'Name either a permissionSet or a profile.';
  return profile
    ? resolveProfileAccess(context, access, profile)
    : resolvePermissionSet(context, access, set ?? '');
}
