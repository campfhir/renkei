/**
 * Permission sets and profiles: reading sets (what one grants, who has it),
 * proposing a new set, more access in an existing set or a profile, field
 * access taken away from one, and who has the sets.
 *
 * A new set deploys as metadata with its access inside it. Access in an
 * existing set is data — one FieldPermissions, ObjectPermissions or tab
 * setting row at a time — because deploying a set replaces everything in
 * it; the proposal reads what the set grants now and adds to it. A
 * profile's access hangs from its own permission set, so it is read and
 * written the same way. Nothing is taken away unless the proposal names it
 * (removeFields), and the review page shows each as its own line.
 * Assignments are data too, behind their own capability (user access),
 * which is off by default.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  checkPermissionSetName,
  impliedRights,
  metadataFile,
  metadataFileName,
  packageXml,
  permissionSetFile,
  rightsLabel,
  soqlString,
  unionRights,
  withoutRights,
  type ObjectRights,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import {
  errText,
  rec,
  sfQuery,
  str,
  textResult,
  type SalesforceAccess,
} from '../salesforce/client';
import { resolveObject } from '../salesforce/schema';
import { limitField } from '../salesforce/fields';
import {
  ASSIGNMENTS_KIND,
  PERMISSION_SET_KIND,
  readCustomField,
  resolvePermissionSet,
  resolveProfileAccess,
  type ComponentView,
  type DataStep,
  type Precondition,
  type ViewRow,
} from '@/lib/salesforce-admin/plan';
import {
  findRecordType,
  listRecordTypes,
  readProfile,
  readWholeMetadata,
} from '@/lib/salesforce-admin/whole-components';
import { loginHoursWords, systemPermissions } from './security-tools';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

const NO_RIGHTS: ObjectRights = {
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
};

const rightsOf = (row: Record<string, unknown>): ObjectRights => ({
  read: row.PermissionsRead === true,
  create: row.PermissionsCreate === true,
  edit: row.PermissionsEdit === true,
  delete: row.PermissionsDelete === true,
  viewAll: row.PermissionsViewAllRecords === true,
  modifyAll: row.PermissionsModifyAllRecords === true,
});

const sameRights = (a: ObjectRights, b: ObjectRights) => rightsLabel(a) === rightsLabel(b);

const ALL_RIGHTS: readonly (keyof ObjectRights)[] = [
  'read',
  'create',
  'edit',
  'delete',
  'viewAll',
  'modifyAll',
];

const OBJECT_RIGHTS_FIELDS =
  'SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords';

const inList = (values: readonly string[]) => `(${values.map(soqlString).join(', ')})`;

interface CheckedAccess {
  objects: Map<string, ObjectRights>;
  /** `Object.Field` → edit. */
  fields: Map<string, boolean>;
  tabs: string[];
  notes: string[];
}

/**
 * The access asked for, checked against the org: objects resolved to
 * their API names, fields that exist and take field access (a required
 * field is visible to everyone and takes none), tabs of custom objects.
 */
async function checkAccess(
  context: MCPToolContext,
  access: SalesforceAccess,
  input: {
    objects?: ({ object: string } & Partial<ObjectRights>)[];
    fields?: { object: string; field: string; edit?: boolean }[];
    tabs?: string[];
  },
  /** Something else is given (record types), so no access is fine. */
  allowNone = false
): Promise<CheckedAccess | string[]> {
  const errors: string[] = [];
  const names = new Map<string, string>();
  const objectName = async (ref: string): Promise<string | null> => {
    const key = ref.trim().toLowerCase();
    const known = names.get(key);
    if (known) return known;
    const describe = await resolveObject(context, access, ref);
    if (typeof describe === 'string') {
      errors.push(describe);
      return null;
    }
    names.set(key, describe.name);
    return describe.name;
  };

  const objects = new Map<string, ObjectRights>();
  for (const entry of input.objects ?? []) {
    const name = await objectName(entry.object);
    if (!name) continue;
    const rights = impliedRights(entry);
    if (!rights.read) {
      errors.push(`${name}: name at least one right (read, create, edit…).`);
      continue;
    }
    objects.set(name, unionRights(objects.get(name) ?? NO_RIGHTS, rights));
  }

  const fields = new Map<string, boolean>();
  const byObject = new Map<string, { field: string; edit: boolean }[]>();
  for (const entry of input.fields ?? []) {
    const name = await objectName(entry.object);
    if (!name) continue;
    byObject.set(name, [
      ...(byObject.get(name) ?? []),
      { field: entry.field.trim(), edit: entry.edit === true },
    ]);
  }
  const notes: string[] = [];
  for (const [object, wanted] of byObject) {
    // Every field, whoever can see it, and whether it can take field access.
    const found = await sfQuery(
      context,
      access,
      `SELECT QualifiedApiName, IsNillable, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ${soqlString(object)}`
    );
    if (!found.ok) {
      errors.push(`${object}: ${found.error}`);
      continue;
    }
    for (const { field, edit } of wanted) {
      const row = found.records.find(
        (r) => str(r.QualifiedApiName).toLowerCase() === field.toLowerCase()
      );
      // FieldDefinition answers by the person's own field-level access, so
      // a custom field nobody has been given yet — the very field this is
      // about to grant — is missing from it. Setup's own record of the
      // field (the Tooling API) lists it whoever can see it.
      const hidden =
        !row && /__c$/i.test(field) ? await readCustomField(context, access, object, field) : null;
      const live = hidden && typeof hidden === 'object' ? hidden : null;
      if (!row && !live) {
        errors.push(`${object} has no field ${field}.`);
        continue;
      }
      const name = row
        ? str(row.QualifiedApiName)
        : (live?.fullName.slice(live.fullName.indexOf('.') + 1) ?? field);
      const required = row
        ? row.IsNillable !== true && str(row.DataType) !== 'Checkbox'
        : live?.metadata.required === true;
      if (required) {
        errors.push(
          `${object}.${name} is required (or a name field), so everyone with the object sees it; it takes no field access.`
        );
        continue;
      }
      const key = `${object}.${name}`;
      fields.set(key, (fields.get(key) ?? false) || edit);
    }
    if (!objects.has(object)) {
      notes.push(`Field access on ${object} needs its records’ read access, so that is included.`);
      objects.set(object, impliedRights({ read: true }));
    }
  }

  const tabs: string[] = [];
  for (const ref of input.tabs ?? []) {
    const name = await objectName(ref);
    if (!name) continue;
    if (!/__c$/i.test(name)) {
      errors.push(`${name} is a standard object; this shows custom objects’ tabs only.`);
      continue;
    }
    if (!tabs.includes(name)) tabs.push(name);
  }

  if (errors.length > 0) return errors;
  if (!allowNone && objects.size + fields.size + tabs.length === 0)
    return ['Name some access to give.'];
  return { objects, fields, tabs, notes };
}

/** Record types named as Object.RecordType (API name or label), as the org spells them. */
async function resolveRecordTypes(
  context: MCPToolContext,
  access: SalesforceAccess,
  refs: readonly string[]
): Promise<{ recordTypes: string[]; errors: string[] }> {
  const recordTypes: string[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const dot = ref.indexOf('.');
    if (dot < 1) {
      errors.push(`"${ref}": name it as Object.RecordType.`);
      continue;
    }
    const describe = await resolveObject(context, access, ref.slice(0, dot));
    if (typeof describe === 'string') {
      errors.push(describe);
      continue;
    }
    const types = await listRecordTypes(context, access, describe.name);
    const rt = typeof types === 'string' ? types : findRecordType(types, ref.slice(dot + 1));
    if (typeof rt === 'string') errors.push(`${describe.name}: ${rt}`);
    else recordTypes.push(`${describe.name}.${rt.developerName}`);
  }
  return { recordTypes, errors };
}

/** Apps by API name or label, as `{ id, name }` — the id a SetupEntityAccess row names. */
async function resolveApps(
  context: MCPToolContext,
  access: SalesforceAccess,
  refs: readonly string[]
): Promise<{ apps: { id: string; name: string }[]; errors: string[] }> {
  const apps: { id: string; name: string }[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const literal = soqlString(ref.trim());
    const found = await sfQuery(
      context,
      access,
      `SELECT DurableId, DeveloperName, Label FROM AppDefinition WHERE DeveloperName = ${literal} OR Label = ${literal} LIMIT 3`
    );
    if (!found.ok) errors.push(`${ref}: ${found.error}`);
    else if (found.records.length === 0) errors.push(`No app "${ref}" in this org.`);
    else if (found.records.length > 1)
      errors.push(
        `"${ref}" names more than one app: ${found.records.map((r) => str(r.DeveloperName)).join(', ')}. Use the API name.`
      );
    else if (!apps.some((app) => app.id === str(found.records[0].DurableId)))
      apps.push({ id: str(found.records[0].DurableId), name: str(found.records[0].Label) });
  }
  return { apps, errors };
}

const many = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(rec);

const accessInput = {
  objects: z
    .array(
      z.object({
        object: z.string().min(1).describe('The object’s API name or label.'),
        read: z.boolean().optional(),
        create: z.boolean().optional(),
        edit: z.boolean().optional().describe('Implies read.'),
        delete: z.boolean().optional().describe('Implies read and edit.'),
        viewAll: z.boolean().optional().describe('Every record, whoever owns it. Implies read.'),
        modifyAll: z.boolean().optional().describe('Every record, every right.'),
      })
    )
    .max(50)
    .optional()
    .describe('Access to records of each object.'),
  fields: z
    .array(
      z.object({
        object: z.string().min(1),
        field: z.string().min(1).describe('The field’s API name.'),
        edit: z.boolean().optional().describe('Edit as well as read (default read only).'),
      })
    )
    .max(200)
    .optional()
    .describe('Field access; the object’s read access comes with it.'),
  tabs: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe('Custom objects whose tabs to show in the app’s navigation.'),
};

export function registerAdminPermissionTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_list_permission_sets',
    {
      title: 'Salesforce Admin · Read — Permission sets',
      description:
        'The org’s permission sets with how many people have each, or its profiles (profiles: ' +
        'true); with `permissionSet` or `profile`, what that one grants — object access, field ' +
        'access (optionally on one object), tabs, apps — and who has it. Read this before proposing ' +
        'access, taking any away, or assignments.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z.string().optional().describe('Words in the name or label.'),
        permissionSet: z.string().optional().describe('A set’s API name or label, to read it.'),
        profile: z
          .string()
          .optional()
          .describe('A profile’s name ("Standard User"), to read what it grants.'),
        profiles: z.boolean().optional().describe('List the org’s profiles, not its sets.'),
        security: z
          .boolean()
          .optional()
          .describe(
            'With permissionSet or profile: also the system permissions it turns on, and a profile’s login hours and IP ranges.'
          ),
        object: z
          .string()
          .optional()
          .describe('With permissionSet or profile: field access on this object.'),
        limit: limitField(200, 100),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (args.permissionSet && args.profile) {
        return errText('Name a permissionSet or a profile, not both.');
      }
      if (!args.permissionSet && !args.profile && args.profiles) {
        const search = args.search?.trim();
        const [found, counts] = await Promise.all([
          sfQuery(
            context,
            access,
            `SELECT Id, Name, UserLicense.Name FROM Profile${
              search ? ` WHERE Name LIKE ${soqlString(`%${search}%`)}` : ''
            } ORDER BY Name LIMIT ${args.limit ?? 100}`
          ),
          sfQuery(
            context,
            access,
            'SELECT ProfileId, COUNT(Id) n FROM User WHERE IsActive = true GROUP BY ProfileId'
          ),
        ]);
        if (!found.ok) return errText(found.error);
        if (found.records.length === 0) return textResult('No profiles match.');
        return textResult(
          found.records
            .map((row) => {
              const count = counts.ok
                ? Number(counts.records.find((c) => str(c.ProfileId) === str(row.Id))?.n ?? 0)
                : null;
              const license = str(rec(row.UserLicense).Name);
              return [
                `• ${str(row.Name)}`,
                count === null ? '' : ` — ${count} active ${count === 1 ? 'person' : 'people'}`,
                license ? `, ${license} licence` : '',
              ].join('');
            })
            .join('\n')
        );
      }
      if (!args.permissionSet && !args.profile) {
        const search = args.search?.trim();
        const found = await sfQuery(
          context,
          access,
          `SELECT Id, Name, Label, Description, NamespacePrefix, License.Name FROM PermissionSet WHERE IsOwnedByProfile = false AND Type = 'Regular'${
            search
              ? ` AND (Name LIKE ${soqlString(`%${search}%`)} OR Label LIKE ${soqlString(`%${search}%`)})`
              : ''
          } ORDER BY Label LIMIT ${args.limit ?? 100}`
        );
        if (!found.ok) return errText(found.error);
        const counts = await sfQuery(
          context,
          access,
          `SELECT PermissionSetId, COUNT(Id) n FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false AND Assignee.IsActive = true GROUP BY PermissionSetId`
        );
        const countOf = (id: string) =>
          counts.ok
            ? Number(counts.records.find((row) => str(row.PermissionSetId) === id)?.n ?? 0)
            : null;
        if (found.records.length === 0) return textResult('No permission sets match.');
        return textResult(
          found.records
            .map((row) => {
              const count = countOf(str(row.Id));
              const managed = str(row.NamespacePrefix);
              const license = str(rec(row.License).Name);
              return [
                `• ${str(row.Label)} (${str(row.Name)})`,
                count === null ? '' : ` — ${count} ${count === 1 ? 'person' : 'people'}`,
                license ? `, ${license} licence` : '',
                managed ? `, managed (${managed}; cannot be changed)` : '',
                str(row.Description) ? `\n  ${str(row.Description)}` : '',
              ].join('');
            })
            .join('\n')
        );
      }

      const profile = args.profile
        ? await resolveProfileAccess(context, access, args.profile)
        : null;
      if (typeof profile === 'string') return errText(profile);
      const set =
        profile ?? (await resolvePermissionSet(context, access, args.permissionSet ?? ''));
      if (typeof set === 'string') return errText(set);
      const parent = soqlString(set.id);
      const object = args.object ? await resolveObject(context, access, args.object) : null;
      if (typeof object === 'string') return errText(object);
      const [objects, fields, tabs, people] = await Promise.all([
        sfQuery(
          context,
          access,
          `SELECT ${OBJECT_RIGHTS_FIELDS} FROM ObjectPermissions WHERE ParentId = ${parent} ORDER BY SobjectType`
        ),
        object
          ? sfQuery(
              context,
              access,
              `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ${parent} AND SobjectType = ${soqlString(object.name)} ORDER BY Field`
            )
          : null,
        sfQuery(
          context,
          access,
          `SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = ${parent} ORDER BY Name`
        ),
        // A profile's people are the users on it; a set's, its assignments.
        profile
          ? sfQuery(
              context,
              access,
              `SELECT Name, Username FROM User WHERE ProfileId = ${soqlString(profile.profileId)} AND IsActive = true ORDER BY Name LIMIT 200`
            )
          : sfQuery(
              context,
              access,
              `SELECT Assignee.Name, Assignee.Username FROM PermissionSetAssignment WHERE PermissionSetId = ${parent} AND Assignee.IsActive = true ORDER BY Assignee.Name LIMIT 200`
            ),
      ]);
      // The apps it may open: its SetupEntityAccess rows that name an app.
      const appAccess = await sfQuery(
        context,
        access,
        `SELECT SetupEntityId FROM SetupEntityAccess WHERE ParentId = ${parent} AND SetupEntityType = 'TabSet' LIMIT 200`
      );
      const apps =
        appAccess.ok && appAccess.records.length > 0
          ? await sfQuery(
              context,
              access,
              `SELECT DurableId, DeveloperName, Label FROM AppDefinition WHERE DurableId IN ${inList(appAccess.records.map((row) => str(row.SetupEntityId)))} ORDER BY Label`
            )
          : appAccess;
      const lines = [profile ? `Profile ${profile.profile}` : `Permission set ${set.name}`];
      lines.push(
        '',
        'Records:',
        ...(objects.ok
          ? objects.records.length
            ? objects.records.map(
                (row) => `• ${str(row.SobjectType)}: ${rightsLabel(rightsOf(row))}`
              )
            : ['• none']
          : [`• could not be read: ${objects.error}`])
      );
      if (fields && object) {
        lines.push(
          '',
          `Fields on ${object.name}:`,
          ...(fields.ok
            ? fields.records.length
              ? fields.records.map(
                  (row) =>
                    `• ${str(row.Field)}: ${row.PermissionsEdit === true ? 'read and edit' : 'read'}`
                )
              : ['• none']
            : [`• could not be read: ${fields.error}`])
        );
      } else {
        lines.push('', 'Field access: name an object to read it.');
      }
      lines.push(
        '',
        'Tabs:',
        ...(tabs.ok
          ? tabs.records.length
            ? tabs.records.map(
                (row) =>
                  `• ${str(row.Name)}${str(row.Visibility) === 'DefaultOn' ? '' : ' (All Tabs only)'}`
              )
            : ['• none']
          : [`• could not be read: ${tabs.error}`]),
        '',
        'Apps:',
        ...(apps.ok
          ? apps.records.length
            ? apps.records.map((row) => `• ${str(row.Label)} (${str(row.DeveloperName)})`)
            : ['• none']
          : [`• could not be read: ${apps.error}`]),
        '',
        'Who has it:',
        ...(people.ok
          ? people.records.length
            ? people.records.map((row) => {
                const person = profile ? row : rec(row.Assignee);
                return `• ${str(person.Name)} (${str(person.Username)})`;
              })
            : ['• nobody']
          : [`• could not be read: ${people.error}`])
      );
      if (args.security) {
        const all = await systemPermissions(context, access);
        if (typeof all === 'string') {
          lines.push('', `System permissions could not be read: ${all}`);
        } else {
          // Every Permissions… checkbox of the row, a hundred fields a query.
          const on: string[] = [];
          let failed = '';
          for (let at = 0; at < all.length && !failed; at += 100) {
            const part = all.slice(at, at + 100);
            const found = await sfQuery(
              context,
              access,
              `SELECT ${part.map((p) => p.field).join(', ')} FROM PermissionSet WHERE Id = ${parent} LIMIT 1`
            );
            if (!found.ok) failed = found.error;
            else
              on.push(
                ...part.filter((p) => found.records[0]?.[p.field] === true).map((p) => p.label)
              );
          }
          lines.push(
            '',
            'System permissions:',
            ...(failed
              ? [`• could not be read: ${failed}`]
              : on.length
                ? on.map((l) => `• ${l}`)
                : ['• none'])
          );
        }
        if (profile) {
          const named = await readProfile(context, access, profile.profile);
          const whole =
            typeof named === 'string'
              ? named
              : await readWholeMetadata(context, access, 'Profile', named.fullName);
          if (typeof whole === 'string' || !whole) {
            lines.push(
              '',
              `Login hours and IP ranges could not be read${whole ? `: ${whole}` : '.'}`
            );
          } else {
            const ranges = many(whole.metadata.loginIpRanges);
            lines.push(
              '',
              `Login hours: ${loginHoursWords(whole.metadata.loginHours)}`,
              'Login IP ranges:',
              ...(ranges.length
                ? ranges.map(
                    (range) =>
                      `• ${str(range.startAddress)}–${str(range.endAddress)}${str(range.description) ? ` (${str(range.description)})` : ''}`
                  )
                : ['• any address'])
            );
          }
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_admin_propose_permission_set',
    {
      title: 'Salesforce Admin · Act — Propose a permission set, or more access',
      description:
        'Propose a new permission set (newSet) with the access it grants, or a change to the ' +
        'access in an existing permission set (permissionSet) or a profile (profile): records ' +
        'of objects (read, create, edit, delete, view all, modify all), fields (read or edit), ' +
        'custom objects’ tabs, apps, and the record types a permission set may use. Access ' +
        'given never takes any away; to take access away ' +
        'from an existing set or profile, name it: removeFields (all of a field’s access, or ' +
        'only edit), removeObjects (all access to an object’s records, or named rights), ' +
        'removeTabs and removeApps. Read what it grants first (salesforce_admin_list_permission_sets). The ' +
        'person reviews and applies it from the link this returns; who has a set is ' +
        'salesforce_admin_propose_assignments.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        permissionSet: z
          .string()
          .optional()
          .describe('An existing set’s API name or label, to change the access in it.'),
        profile: z
          .string()
          .optional()
          .describe(
            'A profile’s name ("Standard User"), to change the access in it, instead of permissionSet.'
          ),
        newSet: z
          .object({
            label: z.string().min(1).max(80),
            apiName: z.string().optional().describe('Default from the label.'),
            description: z.string().max(255).optional(),
          })
          .optional()
          .describe('A new permission set, instead of permissionSet or profile.'),
        ...accessInput,
        removeFields: z
          .array(
            z.object({
              object: z.string().min(1),
              field: z.string().min(1).describe('The field’s API name.'),
              keepRead: z
                .boolean()
                .optional()
                .describe('Take only edit away, leaving read (default: take all access away).'),
            })
          )
          .max(200)
          .optional()
          .describe(
            'Existing sets and profiles only: field access to take away. People keep any access another set or their profile gives them.'
          ),
        removeObjects: z
          .array(
            z.object({
              object: z.string().min(1).describe('The object’s API name or label.'),
              rights: z
                .array(z.enum(['read', 'create', 'edit', 'delete', 'viewAll', 'modifyAll']))
                .max(6)
                .optional()
                .describe(
                  'The rights to take away (default all). A right goes with what it stands on: without read, none; without edit, no delete; modify all goes when any other right does.'
                ),
            })
          )
          .max(50)
          .optional()
          .describe(
            'Existing sets and profiles only: access to an object’s records to take away. Salesforce refuses to take read away while field access on the object remains, so name those fields in removeFields too.'
          ),
        removeTabs: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe('Existing sets and profiles only: custom objects’ tabs to stop showing.'),
        recordTypes: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe(
            'Permission sets, new or existing: record types people with it can use, as Object.RecordType (API name or label). On an existing set this deploys the set whole, as read, with the record types added.'
          ),
        apps: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Existing sets and profiles only: apps it may open, by API name or label.'),
        removeApps: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Existing sets and profiles only: apps it may no longer open.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      if ([args.permissionSet, args.newSet, args.profile].filter(Boolean).length !== 1) {
        return errText(
          'Name one of permissionSet (an existing set), profile (a profile) or newSet (a new set).'
        );
      }
      const removing = args.removeFields ?? [];
      const removingObjects = args.removeObjects ?? [];
      const removingTabs = args.removeTabs ?? [];
      const takesAway = removing.length + removingObjects.length + removingTabs.length > 0;
      if (args.newSet && takesAway) {
        return errText(
          'A new permission set has no access to take away: leave removeFields, removeObjects and removeTabs out.'
        );
      }
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const checkedErrors: string[] = [];
      const wantsRecordTypes = (args.recordTypes ?? []).length > 0;
      if (args.profile && wantsRecordTypes) {
        return errText(
          'A profile is given a record type, with its layout, by salesforce_admin_propose_record_type (profiles).'
        );
      }
      const appRefs = [...(args.apps ?? []), ...(args.removeApps ?? [])];
      if (args.newSet && appRefs.length > 0) {
        return errText(
          'Apps are given to a set once it exists: propose the new set, and once it is applied, propose apps for it.'
        );
      }

      const checked = await checkAccess(
        context,
        access,
        args,
        wantsRecordTypes || appRefs.length > 0 || takesAway
      );
      if (Array.isArray(checked))
        return errText(`Nothing was proposed:\n${checked.map((e) => `• ${e}`).join('\n')}`);

      if (args.newSet) {
        const resolved = await resolveRecordTypes(context, access, args.recordTypes ?? []);
        const recordTypes = resolved.recordTypes;
        checkedErrors.push(...resolved.errors);
        if (checkedErrors.length > 0)
          return errText(`Nothing was proposed:\n${checkedErrors.map((e) => `• ${e}`).join('\n')}`);
        const label = args.newSet.label.trim();
        const name = args.newSet.apiName?.trim() ?? '';
        const taken = await sfQuery(
          context,
          access,
          `SELECT Name, Label FROM PermissionSet WHERE Label = ${soqlString(label)}${name ? ` OR Name = ${soqlString(name)}` : ''} LIMIT 5`
        );
        if (!taken.ok) return errText(taken.error);
        const named = checkPermissionSetName(
          { label, name },
          taken.records.map((row) => ({ name: str(row.Name), label: str(row.Label) }))
        );
        if (!named.ok)
          return errText(`Nothing was proposed:\n${named.errors.map((e) => `• ${e}`).join('\n')}`);
        // The derived name can only be checked once it is known.
        if (!name) {
          const again = await sfQuery(
            context,
            access,
            `SELECT Id FROM PermissionSet WHERE Name = ${soqlString(named.name)} LIMIT 1`
          );
          if (!again.ok) return errText(again.error);
          if (again.records.length > 0)
            return errText(
              `Nothing was proposed: there is already a permission set ${named.name}; give apiName.`
            );
        }
        const description = args.newSet.description?.trim();
        const objects = [...checked.objects].map(([object, rights]) => ({ object, ...rights }));
        const fields = [...checked.fields].map(([field, edit]) => ({ field, edit }));
        const members = [{ type: 'PermissionSet', member: named.name }];
        const rows: ViewRow[] = [
          { label: 'Label', value: named.label },
          ...(description ? [{ label: 'Description', value: description }] : []),
          ...objects.map((o) => ({ label: `${o.object} records`, value: rightsLabel(o) })),
          ...fields.map((f) => ({ label: f.field, value: f.edit ? 'read and edit' : 'read' })),
          ...checked.tabs.map((tab) => ({ label: `${tab} tab`, value: 'shown' })),
          ...recordTypes.map((rt) => ({ label: `${rt} record type`, value: 'may use' })),
        ];
        return proposeAndValidate(context, access, {
          kind: PERMISSION_SET_KIND,
          title: `New permission set ${named.label}`,
          reason: args.reason,
          replaces: args.replaces,
          payload: {
            files: {
              'package.xml': packageXml(members),
              [`permissionsets/${metadataFileName(named.name)}.permissionset`]: permissionSetFile({
                name: named.name,
                label: named.label,
                ...(description ? { description } : {}),
                objects,
                fields,
                tabs: checked.tabs,
                recordTypes,
              }),
            },
            members,
            components: [{ type: 'PermissionSet', name: named.name, action: 'create', rows }],
            preconditions: [{ kind: 'permission-set-absent', name: named.name }],
            dataSteps: [],
          },
          summary: [
            `• New permission set ${named.label} (${named.name}), assigned to nobody yet:`,
            ...rows.slice(1).map((row) => `  ${row.label}: ${row.value}`),
            ...checked.notes,
          ],
        });
      }

      const profile = args.profile
        ? await resolveProfileAccess(context, access, args.profile)
        : null;
      if (typeof profile === 'string') return errText(profile);
      const set =
        profile ?? (await resolvePermissionSet(context, access, args.permissionSet ?? ''));
      if (typeof set === 'string') return errText(set);
      const parent = soqlString(set.id);

      // Field access to take away: each field named as the org spells it,
      // and not one this same proposal gives access to.
      const removals = new Map<string, boolean>();
      const removalErrors: string[] = [];
      for (const entry of removing) {
        const describe = await resolveObject(context, access, entry.object);
        if (typeof describe === 'string') {
          removalErrors.push(describe);
          continue;
        }
        const key = `${describe.name}.${entry.field.trim()}`;
        if ([...checked.fields.keys()].some((f) => f.toLowerCase() === key.toLowerCase())) {
          removalErrors.push(`${key} is both given and taken away: name it once.`);
          continue;
        }
        removals.set(key, entry.keepRead === true);
      }
      // Records' access and tabs to take away, by the org's own names.
      const objectRemovals = new Map<string, readonly (keyof ObjectRights)[]>();
      for (const entry of removingObjects) {
        const describe = await resolveObject(context, access, entry.object);
        if (typeof describe === 'string') {
          removalErrors.push(describe);
          continue;
        }
        if (checked.objects.has(describe.name)) {
          removalErrors.push(
            `${describe.name} records are both given and taken away: name them once.`
          );
          continue;
        }
        objectRemovals.set(describe.name, entry.rights?.length ? entry.rights : ALL_RIGHTS);
      }
      const tabRemovals: string[] = [];
      for (const ref of removingTabs) {
        const describe = await resolveObject(context, access, ref);
        if (typeof describe === 'string') {
          removalErrors.push(describe);
          continue;
        }
        if (checked.tabs.includes(describe.name)) {
          removalErrors.push(`The ${describe.name} tab is both shown and hidden: name it once.`);
          continue;
        }
        if (!tabRemovals.includes(describe.name)) tabRemovals.push(describe.name);
      }
      if (removalErrors.length > 0) {
        return errText(`Nothing was proposed:\n${removalErrors.map((e) => `• ${e}`).join('\n')}`);
      }
      const objectNames = [
        ...new Set([
          ...objectRemovals.keys(),
          ...checked.objects.keys(),
          ...[...checked.fields.keys()].map((f) => f.split('.')[0]),
        ]),
      ];
      const [objectRows, fieldRows, removalRows, tabRows] = await Promise.all([
        objectNames.length > 0
          ? sfQuery(
              context,
              access,
              `SELECT ${OBJECT_RIGHTS_FIELDS} FROM ObjectPermissions WHERE ParentId = ${parent} AND SobjectType IN ${inList(objectNames)}`
            )
          : null,
        checked.fields.size > 0
          ? sfQuery(
              context,
              access,
              `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ${parent} AND Field IN ${inList([...checked.fields.keys()])}`
            )
          : null,
        removals.size > 0
          ? sfQuery(
              context,
              access,
              `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ${parent} AND Field IN ${inList([...removals.keys()])}`
            )
          : null,
        checked.tabs.length + tabRemovals.length > 0
          ? sfQuery(
              context,
              access,
              `SELECT Name FROM PermissionSetTabSetting WHERE ParentId = ${parent} AND Name IN ${inList([...checked.tabs, ...tabRemovals])}`
            )
          : null,
      ]);
      for (const result of [objectRows, fieldRows, tabRows, removalRows]) {
        if (result && !result.ok) return errText(result.error);
      }
      const recordsOf = (result: typeof fieldRows) => (result?.ok ? result.records : []);

      const base = { permissionSetId: set.id, permissionSetName: set.name };
      const steps: DataStep[] = [];
      const rows: ViewRow[] = [];
      for (const [object, wanted] of checked.objects) {
        const row = recordsOf(objectRows).find(
          (r) => str(r.SobjectType).toLowerCase() === object.toLowerCase()
        );
        const now = row ? rightsOf(row) : NO_RIGHTS;
        const next = unionRights(now, wanted);
        if (sameRights(now, next)) continue;
        steps.push({ kind: 'object-permission', ...base, object, ...next });
        rows.push({ label: `${object} records`, value: rightsLabel(next), from: rightsLabel(now) });
      }
      for (const tab of checked.tabs) {
        if (recordsOf(tabRows).some((r) => str(r.Name).toLowerCase() === tab.toLowerCase()))
          continue;
        steps.push({ kind: 'tab-visibility', ...base, tab, visibility: 'DefaultOn' });
        rows.push({ label: `${tab} tab`, value: 'shown', from: 'hidden' });
      }
      for (const [key, edit] of checked.fields) {
        const row = recordsOf(fieldRows).find(
          (r) => str(r.Field).toLowerCase() === key.toLowerCase()
        );
        const nowRead = row?.PermissionsRead === true;
        const nowEdit = row?.PermissionsEdit === true;
        const nextEdit = nowEdit || edit;
        if (nowRead && nowEdit === nextEdit) continue;
        const [object, field] = key.split('.');
        steps.push({
          kind: 'field-permission',
          ...base,
          object,
          field,
          read: true,
          edit: nextEdit,
        });
        rows.push({
          label: key,
          value: nextEdit ? 'read and edit' : 'read',
          from: nowEdit ? 'read and edit' : nowRead ? 'read' : 'none',
        });
      }
      const unchanged: string[] = [];
      for (const [key, keepRead] of removals) {
        const row = recordsOf(removalRows).find(
          (r) => str(r.Field).toLowerCase() === key.toLowerCase()
        );
        const nowRead = row?.PermissionsRead === true;
        const nowEdit = row?.PermissionsEdit === true;
        if (!row || (!nowRead && !nowEdit)) {
          unchanged.push(`${set.name} gives no access to ${key} to take away.`);
          continue;
        }
        if (keepRead && !nowEdit) {
          unchanged.push(`${set.name} already gives read-only access to ${key}.`);
          continue;
        }
        // The org's own spelling of the field, from the row.
        const name = str(row.Field) || key;
        const [object, field] = [
          name.slice(0, name.indexOf('.')),
          name.slice(name.indexOf('.') + 1),
        ];
        steps.push({
          kind: 'field-permission',
          ...base,
          object,
          field,
          read: keepRead,
          edit: false,
          remove: keepRead ? 'edit' : 'all',
        });
        rows.push({
          label: name,
          value: keepRead ? 'read' : 'none',
          from: nowEdit ? 'read and edit' : 'read',
        });
      }
      // Records' access goes after the field access that stands on it.
      for (const [object, rights] of objectRemovals) {
        const row = recordsOf(objectRows).find(
          (r) => str(r.SobjectType).toLowerCase() === object.toLowerCase()
        );
        const now = row ? rightsOf(row) : NO_RIGHTS;
        const next = withoutRights(now, rights);
        if (!now.read) {
          unchanged.push(`${set.name} gives no access to ${object} records to take away.`);
          continue;
        }
        if (sameRights(now, next)) {
          unchanged.push(`${set.name} does not give ${rights.join(', ')} on ${object} records.`);
          continue;
        }
        steps.push({ kind: 'object-permission', ...base, object, ...next, remove: true });
        rows.push({
          label: `${object} records`,
          value: next.read ? rightsLabel(next) : 'none',
          from: rightsLabel(now),
        });
      }
      for (const tab of tabRemovals) {
        if (!recordsOf(tabRows).some((r) => str(r.Name).toLowerCase() === tab.toLowerCase())) {
          unchanged.push(`${set.name} does not show the ${tab} tab.`);
          continue;
        }
        steps.push({ kind: 'tab-visibility', ...base, tab, visibility: 'DefaultOn', remove: true });
        rows.push({ label: `${tab} tab`, value: 'hidden', from: 'shown' });
      }
      // Apps: a SetupEntityAccess row each.
      const [wantedApps, unwantedApps] = await Promise.all([
        resolveApps(context, access, args.apps ?? []),
        resolveApps(context, access, args.removeApps ?? []),
      ]);
      const appErrors = [...wantedApps.errors, ...unwantedApps.errors];
      for (const app of wantedApps.apps) {
        if (unwantedApps.apps.some((other) => other.id === app.id))
          appErrors.push(`The app ${app.name} is both given and taken away: name it once.`);
      }
      if (appErrors.length > 0)
        return errText(`Nothing was proposed:\n${appErrors.map((e) => `• ${e}`).join('\n')}`);
      const appIds = [...wantedApps.apps, ...unwantedApps.apps].map((app) => app.id);
      const appRows =
        appIds.length > 0
          ? await sfQuery(
              context,
              access,
              `SELECT SetupEntityId FROM SetupEntityAccess WHERE ParentId = ${parent} AND SetupEntityId IN ${inList(appIds)}`
            )
          : null;
      if (appRows && !appRows.ok) return errText(appRows.error);
      const opens = (id: string) =>
        recordsOf(appRows).some((row) => str(row.SetupEntityId).slice(0, 15) === id.slice(0, 15));
      for (const app of wantedApps.apps) {
        if (opens(app.id)) {
          unchanged.push(`${set.name} can already open the app ${app.name}.`);
          continue;
        }
        steps.push({ kind: 'app-visibility', ...base, appId: app.id, app: app.name });
        rows.push({ label: `${app.name} app`, value: 'may open', from: 'may not' });
      }
      for (const app of unwantedApps.apps) {
        if (!opens(app.id)) {
          unchanged.push(`${set.name} does not open the app ${app.name}.`);
          continue;
        }
        steps.push({ kind: 'app-visibility', ...base, appId: app.id, app: app.name, remove: true });
        rows.push({ label: `${app.name} app`, value: 'may not', from: 'may open' });
      }

      // Record types have no row of their own to write: the set deploys
      // whole, exactly as read, with the record types added — and applying
      // is refused if the set moved since.
      const files: Record<string, string> = {};
      const members: { type: string; member: string }[] = [];
      const preconditions: Precondition[] = [];
      if (wantsRecordTypes) {
        const resolved = await resolveRecordTypes(context, access, args.recordTypes ?? []);
        if (resolved.errors.length > 0) {
          return errText(
            `Nothing was proposed:\n${resolved.errors.map((e) => `• ${e}`).join('\n')}`
          );
        }
        const live = await readWholeMetadata(context, access, 'PermissionSet', set.name);
        if (typeof live === 'string') return errText(`Nothing was proposed: ${live}`);
        if (!live) return errText(`Nothing was proposed: ${set.name} could not be read whole.`);
        const visible = many(live.metadata.recordTypeVisibilities);
        const adding = resolved.recordTypes.filter(
          (recordType) =>
            !visible.some(
              (entry) =>
                str(entry.recordType).toLowerCase() === recordType.toLowerCase() &&
                String(entry.visible) === 'true'
            )
        );
        for (const recordType of resolved.recordTypes.filter((rt) => !adding.includes(rt))) {
          unchanged.push(`${set.name} may already use the record type ${recordType}.`);
        }
        if (adding.length > 0) {
          files[`permissionsets/${metadataFileName(set.name)}.permissionset`] = metadataFile(
            'PermissionSet',
            {
              ...live.metadata,
              recordTypeVisibilities: [
                ...visible.filter(
                  (entry) =>
                    !adding.some((rt) => rt.toLowerCase() === str(entry.recordType).toLowerCase())
                ),
                ...adding.map((recordType) => ({ recordType, visible: true })),
              ],
            }
          );
          members.push({ type: 'PermissionSet', member: set.name });
          files['package.xml'] = packageXml(members);
          preconditions.push({
            kind: 'component-unchanged',
            type: 'PermissionSet',
            object: '',
            name: set.name,
            fingerprint: live.fingerprint,
          });
          for (const recordType of adding) {
            rows.push({ label: `${recordType} record type`, value: 'may use', from: 'may not' });
          }
        }
      }

      if (steps.length + members.length === 0) {
        return errText(
          unchanged.length > 0
            ? `Nothing was proposed: nothing would change.\n${unchanged.map((e) => `• ${e}`).join('\n')}`
            : `Nothing was proposed: ${set.name} already grants all of that.`
        );
      }
      const takes = (step: DataStep) => 'remove' in step && Boolean(step.remove);
      const taking = steps.some(takes);
      const giving = steps.some((step) => !takes(step)) || members.length > 0;
      const profileName = profile?.profile ?? null;
      const holder = profileName ? `The profile ${profileName}` : set.name;
      const componentName = profileName ?? set.name;
      return proposeAndValidate(context, access, {
        kind: PERMISSION_SET_KIND,
        title: `${holder}: ${taking ? (giving ? 'change access' : 'less access') : 'more access'}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files,
          members,
          components: [
            {
              type: profileName ? 'Profile' : 'PermissionSet',
              name: componentName,
              action: 'update',
              rows,
            },
          ],
          preconditions,
          dataSteps: steps,
        },
        summary: [
          taking
            ? `• ${holder} changes (only what is listed; people keep any access another set or their profile gives them):`
            : `• ${holder} gets (nothing it grants now is taken away):`,
          ...rows.map((row) => `  ${row.label}: ${row.from} → ${row.value}`),
          ...unchanged,
          ...checked.notes,
        ],
      });
    }
  );

  server.registerTool(
    'salesforce_admin_propose_permission_set_details',
    {
      title: 'Salesforce Admin · Act — Propose renaming or deleting a permission set',
      description:
        'Propose a new label or description for an existing permission set (its API name ' +
        'stays, so nothing that refers to it breaks), or deleting one nobody is assigned ' +
        '(delete: true). The person reviews and applies it from the link this returns. A ' +
        'deleted set cannot be brought back from Renkei.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        permissionSet: z.string().min(1).describe('The set’s API name or label.'),
        label: z.string().min(1).max(80).optional().describe('Its new label.'),
        description: z.string().max(255).optional().describe('Its new description.'),
        delete: z.boolean().optional().describe('Delete the set, in place of changing it.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const changing = args.label !== undefined || args.description !== undefined;
      if (Boolean(args.delete) === changing) {
        return errText('Give a new label or description, or delete: true — one or the other.');
      }
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const set = await resolvePermissionSet(context, access, args.permissionSet);
      if (typeof set === 'string') return errText(set);
      const found = await sfQuery(
        context,
        access,
        `SELECT Label, Description, NamespacePrefix FROM PermissionSet WHERE Id = ${soqlString(set.id)} LIMIT 1`
      );
      if (!found.ok) return errText(found.error);
      const now = found.records[0] ?? {};
      if (str(now.NamespacePrefix)) {
        return errText(
          `Nothing was proposed: ${set.name} belongs to the managed package ${str(now.NamespacePrefix)} and cannot be changed.`
        );
      }
      const base = { permissionSetId: set.id, permissionSetName: set.name };

      if (args.delete) {
        const held = await sfQuery(
          context,
          access,
          `SELECT COUNT(Id) n FROM PermissionSetAssignment WHERE PermissionSetId = ${soqlString(set.id)}`
        );
        if (!held.ok) return errText(held.error);
        const people = Number(held.records[0]?.n ?? 0);
        if (people > 0) {
          return errText(
            `Nothing was proposed: ${people} ${people === 1 ? 'person has' : 'people have'} ${set.name}. Take it away from them first (salesforce_admin_propose_assignments), then delete it.`
          );
        }
        return proposeAndValidate(context, access, {
          kind: PERMISSION_SET_KIND,
          title: `Delete the permission set ${str(now.Label) || set.name}`,
          reason: args.reason,
          replaces: args.replaces,
          payload: {
            files: {},
            members: [],
            components: [
              {
                type: 'PermissionSet',
                name: set.name,
                action: 'delete',
                rows: [
                  { label: 'Label', value: str(now.Label) },
                  { label: 'Assigned to', value: 'nobody' },
                ],
              },
            ],
            preconditions: [],
            dataSteps: [{ kind: 'permission-set-delete', ...base }],
          },
          summary: [
            `• Delete the permission set ${set.name}, which nobody is assigned. It cannot be brought back from Renkei.`,
          ],
        });
      }

      const label = args.label?.trim();
      const description = args.description?.trim();
      const rows: ViewRow[] = [];
      if (label !== undefined && label !== str(now.Label)) {
        const taken = await sfQuery(
          context,
          access,
          `SELECT Name FROM PermissionSet WHERE Label = ${soqlString(label)} AND Id != ${soqlString(set.id)} LIMIT 1`
        );
        if (!taken.ok) return errText(taken.error);
        if (taken.records.length > 0) {
          return errText(
            `Nothing was proposed: there is already a permission set labelled “${label}” (${str(taken.records[0].Name)}).`
          );
        }
        rows.push({ label: 'Label', value: label, from: str(now.Label) });
      }
      if (description !== undefined && description !== str(now.Description)) {
        rows.push({ label: 'Description', value: description, from: str(now.Description) });
      }
      if (rows.length === 0) {
        return errText(`Nothing was proposed: ${set.name} already reads that way.`);
      }
      const renamed = rows.some((row) => row.label === 'Label');
      const described = rows.some((row) => row.label === 'Description');
      return proposeAndValidate(context, access, {
        kind: PERMISSION_SET_KIND,
        title: `${set.name}: ${renamed ? 'rename' : 'describe'}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files: {},
          members: [],
          components: [{ type: 'PermissionSet', name: set.name, action: 'update', rows }],
          preconditions: [],
          dataSteps: [
            {
              kind: 'permission-set-details',
              ...base,
              ...(renamed && label !== undefined ? { label } : {}),
              ...(described && description !== undefined ? { description } : {}),
            },
          ],
        },
        summary: [
          `• ${set.name} (its API name stays):`,
          ...rows.map(
            (row) => `  ${row.label}: ${row.from || '(blank)'} → ${row.value || '(blank)'}`
          ),
        ],
      });
    }
  );

  server.registerTool(
    'salesforce_admin_propose_assignments',
    {
      title: 'Salesforce Admin · Act — Propose who has permission sets',
      description:
        'Propose assigning permission sets to people, or removing them, by username, email or ' +
        'full name. This changes what those people can do in the org; the person reviews and ' +
        'applies it from the link this returns. People who already have (or lack) a set are ' +
        'left out and named.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        assign: z
          .array(
            z.object({
              permissionSet: z.string().min(1),
              users: z.array(z.string().min(1)).min(1).max(50),
            })
          )
          .max(10)
          .optional(),
        remove: z
          .array(
            z.object({
              permissionSet: z.string().min(1),
              users: z.array(z.string().min(1)).min(1).max(50),
            })
          )
          .max(10)
          .optional(),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const groups = [
        ...(args.assign ?? []).map((g) => ({ ...g, kind: 'assign' as const })),
        ...(args.remove ?? []).map((g) => ({ ...g, kind: 'unassign' as const })),
      ];
      if (groups.length === 0) return errText('Name permission sets to assign or remove.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);

      const errors: string[] = [];
      const users = new Map<string, { id: string; name: string } | null>();
      const userOf = async (ref: string, assigning: boolean) => {
        const key = ref.trim().toLowerCase();
        if (users.has(key)) return users.get(key) ?? null;
        const literal = soqlString(ref.trim());
        const found = await sfQuery(
          context,
          access,
          `SELECT Id, Name, Username, IsActive FROM User WHERE Username = ${literal} OR Email = ${literal} OR Name = ${literal} LIMIT 3`
        );
        let user: { id: string; name: string } | null = null;
        if (!found.ok) errors.push(`${ref}: ${found.error}`);
        else if (found.records.length === 0) errors.push(`No user "${ref}" in this org.`);
        else if (found.records.length > 1)
          errors.push(
            `"${ref}" names more than one user: ${found.records.map((r) => str(r.Username)).join(', ')}. Use the username.`
          );
        else if (assigning && found.records[0].IsActive !== true)
          errors.push(`${str(found.records[0].Name)} is not an active user.`);
        else
          user = {
            id: str(found.records[0].Id),
            name: `${str(found.records[0].Name)} (${str(found.records[0].Username)})`,
          };
        users.set(key, user);
        return user;
      };

      const steps: DataStep[] = [];
      const skipped: string[] = [];
      const components: ComponentView[] = [];
      for (const group of groups) {
        const set = await resolvePermissionSet(context, access, group.permissionSet);
        if (typeof set === 'string') {
          errors.push(set);
          continue;
        }
        const people: { id: string; name: string }[] = [];
        for (const ref of group.users) {
          const user = await userOf(ref, group.kind === 'assign');
          if (user && !people.some((p) => p.id === user.id)) people.push(user);
        }
        if (people.length === 0) continue;
        const held = await sfQuery(
          context,
          access,
          `SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = ${soqlString(set.id)} AND AssigneeId IN ${inList(people.map((p) => p.id))}`
        );
        if (!held.ok) {
          errors.push(held.error);
          continue;
        }
        const has = new Set(held.records.map((row) => str(row.AssigneeId)));
        const changing = people.filter((p) => (group.kind === 'assign') !== has.has(p.id));
        for (const p of people.filter((p) => !changing.includes(p))) {
          skipped.push(
            `${p.name} ${group.kind === 'assign' ? 'already has' : 'does not have'} ${set.name}.`
          );
        }
        for (const p of changing) {
          steps.push({
            kind: group.kind,
            permissionSetId: set.id,
            permissionSetName: set.name,
            userId: p.id,
            userName: p.name,
          });
        }
        if (changing.length > 0) {
          components.push({
            type: 'PermissionSet',
            name: set.name,
            action: 'update',
            rows: [
              {
                label: group.kind === 'assign' ? 'Assign to' : 'Remove from',
                value: changing.map((p) => p.name).join(', '),
              },
            ],
          });
        }
      }
      if (errors.length > 0)
        return errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);
      if (steps.length === 0)
        return errText(`Nothing was proposed: nothing would change.\n${skipped.join('\n')}`);
      const assigned = steps.filter((s) => s.kind === 'assign').length;
      const removed = steps.length - assigned;
      return proposeAndValidate(context, access, {
        kind: ASSIGNMENTS_KIND,
        title: `Permission set assignments: ${[
          assigned > 0 && `${assigned} to give`,
          removed > 0 && `${removed} to take away`,
        ]
          .filter(Boolean)
          .join(', ')}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: { files: {}, members: [], components, preconditions: [], dataSteps: steps },
        summary: [
          ...components.map(
            (c) =>
              `• ${c.name}: ${c.rows.map((r) => `${r.label.toLowerCase()} ${r.value}`).join('; ')}`
          ),
          ...skipped,
        ],
      });
    }
  );
}
