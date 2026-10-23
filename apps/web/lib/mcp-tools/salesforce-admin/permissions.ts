/**
 * Permission sets: reading them (what one grants, who has it), proposing a
 * new one or more access in an existing one, and proposing who has them.
 *
 * A new set deploys as metadata with its access inside it. Access added to
 * an existing set is data — one FieldPermissions, ObjectPermissions or tab
 * setting row at a time — because deploying a set replaces everything in
 * it; the proposal reads what the set grants now and only ever adds to it.
 * Assignments are data too, behind their own capability (user access),
 * which is off by default.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  checkPermissionSetName,
  impliedRights,
  metadataFileName,
  packageXml,
  permissionSetFile,
  rightsLabel,
  soqlString,
  unionRights,
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
  resolvePermissionSet,
  type ComponentView,
  type DataStep,
  type ViewRow,
} from '@/lib/salesforce-admin/plan';
import { findRecordType, listRecordTypes } from '@/lib/salesforce-admin/whole-components';
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
      if (!row) {
        errors.push(`${object} has no field ${field}.`);
        continue;
      }
      const name = str(row.QualifiedApiName);
      if (row.IsNillable !== true && str(row.DataType) !== 'Checkbox') {
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
        'The org’s permission sets (not profiles) with how many people have each; with ' +
        '`permissionSet`, what that one grants — object access, field access (optionally on one ' +
        'object), tabs — and who has it. Read this before proposing access or assignments.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z.string().optional().describe('Words in the name or label.'),
        permissionSet: z.string().optional().describe('A set’s API name or label, to read it.'),
        object: z.string().optional().describe('With permissionSet: field access on this object.'),
        limit: limitField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!args.permissionSet) {
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

      const set = await resolvePermissionSet(context, access, args.permissionSet);
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
        sfQuery(
          context,
          access,
          `SELECT Assignee.Name, Assignee.Username FROM PermissionSetAssignment WHERE PermissionSetId = ${parent} AND Assignee.IsActive = true ORDER BY Assignee.Name LIMIT 200`
        ),
      ]);
      const lines = [`Permission set ${set.name}`];
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
        'Who has it:',
        ...(people.ok
          ? people.records.length
            ? people.records.map(
                (row) => `• ${str(rec(row.Assignee).Name)} (${str(rec(row.Assignee).Username)})`
              )
            : ['• nobody']
          : [`• could not be read: ${people.error}`])
      );
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_admin_propose_permission_set',
    {
      title: 'Salesforce Admin · Act — Propose a permission set, or more access',
      description:
        'Propose a new permission set (newSet) with the access it grants, or more access in an ' +
        'existing one (permissionSet): records of objects (read, create, edit, delete, view ' +
        'all, modify all), fields (read or edit), and custom objects’ tabs. Access added to an ' +
        'existing set never takes any away. The person reviews and applies it from the link ' +
        'this returns; who has the set is salesforce_admin_propose_assignments.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        permissionSet: z
          .string()
          .optional()
          .describe('An existing set’s API name or label, to add access to it.'),
        newSet: z
          .object({
            label: z.string().min(1).max(80),
            apiName: z.string().optional().describe('Default from the label.'),
            description: z.string().max(255).optional(),
          })
          .optional()
          .describe('A new permission set, instead of permissionSet.'),
        ...accessInput,
        recordTypes: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe(
            'New sets only: record types people with it can use, as Object.RecordType (API name or label).'
          ),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      if (Boolean(args.permissionSet) === Boolean(args.newSet)) {
        return errText('Name either permissionSet (an existing set) or newSet (a new one).');
      }
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const checkedErrors: string[] = [];
      if (!args.newSet && (args.recordTypes ?? []).length > 0) {
        return errText(
          'Record types can be given in a new permission set only: an existing set deploys whole, which would drop everything else it grants. Give the record type to profiles (salesforce_admin_propose_record_type), or create a set for it.'
        );
      }

      const checked = await checkAccess(
        context,
        access,
        args,
        Boolean(args.newSet) && (args.recordTypes ?? []).length > 0
      );
      if (Array.isArray(checked))
        return errText(`Nothing was proposed:\n${checked.map((e) => `• ${e}`).join('\n')}`);

      if (args.newSet) {
        const recordTypes: string[] = [];
        for (const ref of args.recordTypes ?? []) {
          const dot = ref.indexOf('.');
          if (dot < 1) {
            checkedErrors.push(`"${ref}": name it as Object.RecordType.`);
            continue;
          }
          const describe = await resolveObject(context, access, ref.slice(0, dot));
          if (typeof describe === 'string') {
            checkedErrors.push(describe);
            continue;
          }
          const types = await listRecordTypes(context, access, describe.name);
          const rt = typeof types === 'string' ? types : findRecordType(types, ref.slice(dot + 1));
          if (typeof rt === 'string') checkedErrors.push(`${describe.name}: ${rt}`);
          else recordTypes.push(`${describe.name}.${rt.developerName}`);
        }
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

      const set = await resolvePermissionSet(context, access, args.permissionSet ?? '');
      if (typeof set === 'string') return errText(set);
      const parent = soqlString(set.id);
      const objectNames = [
        ...new Set([
          ...checked.objects.keys(),
          ...[...checked.fields.keys()].map((f) => f.split('.')[0]),
        ]),
      ];
      const [objectRows, fieldRows, tabRows] = await Promise.all([
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
        checked.tabs.length > 0
          ? sfQuery(
              context,
              access,
              `SELECT Name FROM PermissionSetTabSetting WHERE ParentId = ${parent} AND Name IN ${inList(checked.tabs)}`
            )
          : null,
      ]);
      for (const result of [objectRows, fieldRows, tabRows]) {
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
      if (steps.length === 0) {
        return errText(`Nothing was proposed: ${set.name} already grants all of that.`);
      }
      return proposeAndValidate(context, access, {
        kind: PERMISSION_SET_KIND,
        title: `${set.name}: more access`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files: {},
          members: [],
          components: [{ type: 'PermissionSet', name: set.name, action: 'update', rows }],
          preconditions: [],
          dataSteps: steps,
        },
        summary: [
          `• ${set.name} gets (nothing it grants now is taken away):`,
          ...rows.map((row) => `  ${row.label}: ${row.from} → ${row.value}`),
          ...checked.notes,
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
