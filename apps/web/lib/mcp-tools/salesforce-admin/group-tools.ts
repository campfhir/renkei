/**
 * Permission set groups, as their own tools.
 *
 * A group bundles permission sets and is what people are usually given.
 * Salesforce works out what a group grants from the sets in it, and keeps
 * that total in a permission set row under the group's name which nobody
 * can write. So a group is never changed the way a set is: the read here
 * shows its sets (which are the org's own to change, and which come with a
 * licence or a package) and its total; the proposal changes which sets are
 * in it. Access itself is changed in one of its own sets, with
 * salesforce_admin_propose_permission_set.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { rightsLabel, soqlString } from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, rec, sfQuery, str, textResult } from '../salesforce/client';
import { resolveObject } from '../salesforce/schema';
import { limitField } from '../salesforce/fields';
import {
  PERMISSION_SET_KIND,
  resolvePermissionSet,
  resolvePermissionSetGroup,
  type DataStep,
  type ViewRow,
} from '@/lib/salesforce-admin/plan';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

const bullets = (errors: string[]) =>
  errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);

export function registerAdminGroupTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_list_permission_set_groups',
    {
      title: 'Salesforce Admin · Read — Permission set groups',
      description:
        'The org’s permission set groups with how many people have each; with `group`, the ' +
        'permission sets in it — which are the org’s own and can be changed, and which come ' +
        'with a Salesforce licence or a package and cannot — what the group grants in total ' +
        '(object access, and field access on one object), and who has it. A group is not ' +
        'changed directly: read it here to find the set to change, then use ' +
        'salesforce_admin_propose_permission_set on that set.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z.string().optional().describe('Words in the name or label.'),
        group: z.string().optional().describe('A group’s API name or label, to read it.'),
        object: z
          .string()
          .optional()
          .describe('With group: its total field access on this object.'),
        limit: limitField(200, 100),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!args.group) {
        const search = args.search?.trim();
        const [found, counts] = await Promise.all([
          sfQuery(
            context,
            access,
            `SELECT Id, DeveloperName, MasterLabel, Description, Status FROM PermissionSetGroup${
              search
                ? ` WHERE DeveloperName LIKE ${soqlString(`%${search}%`)} OR MasterLabel LIKE ${soqlString(`%${search}%`)}`
                : ''
            } ORDER BY MasterLabel LIMIT ${args.limit ?? 100}`
          ),
          sfQuery(
            context,
            access,
            'SELECT PermissionSetGroupId, COUNT(Id) n FROM PermissionSetAssignment WHERE PermissionSetGroupId != null AND Assignee.IsActive = true GROUP BY PermissionSetGroupId'
          ),
        ]);
        if (!found.ok) return errText(found.error);
        if (found.records.length === 0) return textResult('No permission set groups match.');
        return textResult(
          found.records
            .map((row) => {
              const count = counts.ok
                ? Number(
                    counts.records.find((c) => str(c.PermissionSetGroupId) === str(row.Id))?.n ?? 0
                  )
                : null;
              return [
                `• ${str(row.MasterLabel)} (${str(row.DeveloperName)})`,
                count === null ? '' : ` — ${count} ${count === 1 ? 'person' : 'people'}`,
                str(row.Status) && str(row.Status) !== 'Updated' ? `, ${str(row.Status)}` : '',
                str(row.Description) ? `\n  ${str(row.Description)}` : '',
              ].join('');
            })
            .join('\n')
        );
      }

      const group = await resolvePermissionSetGroup(context, access, args.group);
      if (typeof group === 'string') return errText(group);
      const object = args.object ? await resolveObject(context, access, args.object) : null;
      if (typeof object === 'string') return errText(object);
      const own = group.sets.filter((set) => set.editable);
      const fixed = group.sets.filter((set) => !set.editable);
      const lines = [
        `Permission set group ${group.label} (${group.name})`,
        ...(group.description ? [group.description] : []),
        ...(group.status && group.status !== 'Updated'
          ? [`Status: ${group.status} — its total below may not be current.`]
          : []),
        '',
        'Permission sets in it that can be changed (change access here, and everyone with the group gets it):',
        ...(own.length ? own.map((set) => `• ${set.label} (${set.name})`) : ['• none']),
        '',
        'Permission sets in it from a Salesforce licence or a package (not changeable):',
        ...(fixed.length ? fixed.map((set) => `• ${set.label} (${set.name})`) : ['• none']),
      ];

      if (group.totalSetId) {
        const parent = soqlString(group.totalSetId);
        const [objects, fields] = await Promise.all([
          sfQuery(
            context,
            access,
            `SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId = ${parent} ORDER BY SobjectType`
          ),
          object
            ? sfQuery(
                context,
                access,
                `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ${parent} AND SobjectType = ${soqlString(object.name)} ORDER BY Field`
              )
            : null,
        ]);
        lines.push(
          '',
          'What the group grants in total — records:',
          ...(objects.ok
            ? objects.records.length
              ? objects.records.map(
                  (row) =>
                    `• ${str(row.SobjectType)}: ${rightsLabel({
                      read: row.PermissionsRead === true,
                      create: row.PermissionsCreate === true,
                      edit: row.PermissionsEdit === true,
                      delete: row.PermissionsDelete === true,
                      viewAll: row.PermissionsViewAllRecords === true,
                      modifyAll: row.PermissionsModifyAllRecords === true,
                    })}`
                )
              : ['• none']
            : [`• could not be read: ${objects.error}`])
        );
        if (fields && object) {
          lines.push(
            '',
            `In total — fields on ${object.name}:`,
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
          lines.push('', 'Field access in total: name an object to read it.');
        }
      }

      const people = await sfQuery(
        context,
        access,
        `SELECT Assignee.Name, Assignee.Username FROM PermissionSetAssignment WHERE PermissionSetGroupId = ${soqlString(group.id)} AND Assignee.IsActive = true ORDER BY Assignee.Name LIMIT 200`
      );
      lines.push(
        '',
        'Who has the group:',
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
    'salesforce_admin_propose_permission_set_group_changes',
    {
      title: 'Salesforce Admin · Act — Propose which permission sets are in a group',
      description:
        'Propose putting permission sets into an existing permission set group, or taking them ' +
        'out. Everyone who has the group gains or loses what those sets grant, so read the ' +
        'group first (salesforce_admin_list_permission_set_groups). What a set grants is ' +
        'changed with salesforce_admin_propose_permission_set, not here. The person reviews ' +
        'and applies it from the link this returns.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        group: z.string().min(1).describe('The group’s API name or label.'),
        addSets: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Permission sets to put in the group, by API name or label.'),
        removeSets: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Permission sets to take out of the group.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const adding = args.addSets ?? [];
      const removing = args.removeSets ?? [];
      if (adding.length + removing.length === 0) {
        return errText('Name permission sets to add to the group or remove from it.');
      }
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const group = await resolvePermissionSetGroup(context, access, args.group);
      if (typeof group === 'string') return errText(group);

      const inGroup = (name: string) =>
        group.sets.some((set) => set.name.toLowerCase() === name.toLowerCase());
      const errors: string[] = [];
      const unchanged: string[] = [];
      const steps: DataStep[] = [];
      const rows: ViewRow[] = [];
      const seen = new Set<string>();
      for (const [refs, remove] of [
        [adding, false],
        [removing, true],
      ] as const) {
        for (const ref of refs) {
          const set = await resolvePermissionSet(context, access, ref);
          if (typeof set === 'string') {
            errors.push(set);
            continue;
          }
          if (seen.has(set.id)) {
            errors.push(`${set.name} is named more than once.`);
            continue;
          }
          seen.add(set.id);
          if (inGroup(set.name) !== remove) {
            unchanged.push(
              remove
                ? `${set.name} is not in ${group.name}.`
                : `${set.name} is already in ${group.name}.`
            );
            continue;
          }
          steps.push({
            kind: 'group-member',
            permissionSetId: set.id,
            permissionSetName: set.name,
            groupId: group.id,
            group: group.name,
            ...(remove ? { remove: true as const } : {}),
          });
          rows.push({
            label: set.name,
            value: remove ? 'not in the group' : 'in the group',
            from: remove ? 'in the group' : 'not in the group',
          });
        }
      }
      if (errors.length > 0) return bullets(errors);
      if (steps.length === 0) {
        return errText(`Nothing was proposed: nothing would change.\n${unchanged.join('\n')}`);
      }
      const people = await sfQuery(
        context,
        access,
        `SELECT COUNT(Id) n FROM PermissionSetAssignment WHERE PermissionSetGroupId = ${soqlString(group.id)} AND Assignee.IsActive = true`
      );
      const count = people.ok ? Number(people.records[0]?.n ?? 0) : null;
      return proposeAndValidate(context, access, {
        kind: PERMISSION_SET_KIND,
        title: `Permission set group ${group.label}: its permission sets`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files: {},
          members: [],
          components: [{ type: 'PermissionSetGroup', name: group.name, action: 'update', rows }],
          preconditions: [],
          dataSteps: steps,
        },
        summary: [
          `• ${group.name}${count === null ? '' : `, which ${count} ${count === 1 ? 'person has' : 'people have'}`}:`,
          ...rows.map((row) => `  ${row.label}: ${row.from} → ${row.value}`),
          ...unchanged,
        ],
      });
    }
  );
}
