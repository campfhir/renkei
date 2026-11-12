/**
 * Page layouts: reading an object's layouts (which profiles and record
 * types use each, and one layout's sections field by field with its related
 * lists), and proposing a change to one — fields placed, moved, taken off
 * or made required or read only there; sections added, renamed or removed;
 * related lists added or removed; and which profiles see the layout. A
 * layout deploys whole, so a proposal carries the live layout with only its
 * changes merged in (layout-plan.ts), and applying it is refused if anyone
 * edited the layout since it was read. Which profile sees it deploys as a
 * Profile file holding only that assignment, which Salesforce overlays.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  LAYOUT_ACTION_TYPES,
  layoutBehaviors,
  layoutButtons,
  metadataFile,
  layoutRelatedLists,
  layoutSections,
  metadataFileName,
  packageXml,
  profileLayoutFile,
  soqlString,
  type PackageMember,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, rec, str, textResult } from '../salesforce/client';
import { resolveObject } from '../salesforce/schema';
import { objectField } from '../salesforce/fields';
import {
  entityKey,
  LAYOUT_KIND,
  listLayouts,
  readLayout,
  toolingQuery,
  type ComponentView,
  type Precondition,
} from '@/lib/salesforce-admin/plan';
import {
  findRecordType,
  listRecordTypes,
  readProfile,
} from '@/lib/salesforce-admin/whole-components';
import { planLayoutChange } from './layout-plan';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

const behaviorField = z
  .enum(['Edit', 'Required', 'Readonly'])
  .optional()
  .describe('How the field behaves on this layout (default Edit).');

export function registerAdminLayoutTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_get_layout',
    {
      title: 'Salesforce Admin · Read — Page layouts',
      description:
        'An object’s page layouts and which profiles and record types use each; with `layout`, ' +
        'that layout’s sections and the fields in each column, top to bottom (marked where one ' +
        'is required or read only on the layout), and its related lists with their columns. ' +
        'Read this before proposing layout changes, or placing new fields on a layout.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField,
        layout: z.string().optional().describe('A layout’s name, to read its sections.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const layouts = await listLayouts(context, access, describe.name);
      if (typeof layouts === 'string') return errText(layouts);

      const table = await entityKey(context, access, describe.name);
      const used = table
        ? await toolingQuery(
            context,
            access,
            `SELECT LayoutId, Profile.Name, RecordType.Name FROM ProfileLayout WHERE TableEnumOrId = ${soqlString(table)}`
          )
        : null;
      const usersOf = (id: string): string[] =>
        used?.ok
          ? used.records
              .filter((row) => str(row.LayoutId) === id)
              .map((row) => {
                const profile = str(rec(row.Profile).Name) || 'a profile';
                const recordType = str(rec(row.RecordType).Name);
                return recordType ? `${profile} (${recordType})` : profile;
              })
          : [];
      const usedLine = (id: string) => {
        if (!used?.ok) return '  Used by: could not be read.';
        const users = usersOf(id);
        return `  Used by: ${users.length ? users.join(', ') : 'no profile'}`;
      };

      if (!args.layout) {
        if (layouts.length === 0) return textResult(`${describe.name} has no page layouts.`);
        return textResult(
          [
            `${describe.label} (${describe.name}) has ${layouts.length} page layout${layouts.length === 1 ? '' : 's'}:`,
            ...layouts.flatMap((layout) => [`• ${layout.name}`, usedLine(layout.id)]),
            '',
            'Name one as layout to read its sections.',
          ].join('\n')
        );
      }

      const live = await readLayout(context, access, describe.name, args.layout);
      if (typeof live === 'string') return errText(live);
      const sections = layoutSections(live.metadata);
      const behaviors = layoutBehaviors(live.metadata);
      const shown = (field: string) => {
        const behavior = behaviors.get(field.toLowerCase());
        return behavior === 'Required'
          ? `${field} (required)`
          : behavior === 'Readonly'
            ? `${field} (read only)`
            : field;
      };
      const relatedLists = layoutRelatedLists(live.metadata);
      const buttons = layoutButtons(live.metadata);
      return textResult(
        [
          `Layout “${live.name}” on ${describe.name} (${live.fullName})`,
          usedLine(live.id),
          '',
          ...sections.flatMap((section, index) => [
            `${index + 1}. ${section.label || '(no heading)'} — ${section.columns.length} column${section.columns.length === 1 ? '' : 's'}`,
            ...section.columns.map(
              (column, c) =>
                `   Column ${c + 1}: ${column.length ? column.map(shown).join(', ') : '(empty)'}`
            ),
          ]),
          '',
          relatedLists.length > 0 ? 'Related lists, in order:' : 'No related lists.',
          ...relatedLists.map(
            (related) =>
              `• ${related.relatedList}${related.fields.length ? ` — ${related.fields.join(', ')}` : ''}`
          ),
          '',
          `Custom buttons: ${buttons.buttons.join(', ') || 'none'}`,
          buttons.actions
            ? `Lightning and mobile actions, in order: ${buttons.actions.join(', ') || 'none'}`
            : 'Lightning and mobile actions: Salesforce’s defaults (the layout has no list of its own).',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_admin_propose_layout_changes',
    {
      title: 'Salesforce Admin · Act — Propose page layout changes',
      description:
        'Propose changes to one page layout: fields to place (in a named section, default the ' +
        'first with fields), move to another section or another place in one, take off, or ' +
        'make required or read only there; sections to add, rename or remove; related lists ' +
        'to add, remove or give other columns; custom buttons and Lightning actions; and the ' +
        'profiles that see this layout (assignTo), with or without any other change. The ' +
        'proposal carries the live layout with only these changes merged in, checked by a ' +
        'validation deploy that changes nothing; the person reviews and applies it from the ' +
        'link this returns. Read the layout first (salesforce_admin_get_layout).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        layout: z.string().min(1).describe('The layout’s name (salesforce_admin_get_layout).'),
        add: z
          .array(
            z.object({
              field: z.string().min(1).describe('The field’s API name.'),
              section: z.string().optional().describe('The section’s label.'),
              behavior: behaviorField,
            })
          )
          .max(50)
          .optional(),
        remove: z.array(z.string().min(1)).max(50).optional().describe('Fields to take off.'),
        addSections: z
          .array(
            z.object({
              label: z.string().min(1).max(80),
              columns: z.union([z.literal(1), z.literal(2)]).optional(),
              fields: z
                .array(z.object({ field: z.string().min(1), behavior: behaviorField }))
                .max(50)
                .optional(),
            })
          )
          .max(10)
          .optional()
          .describe('New sections, after the last section that holds fields.'),
        move: z
          .array(
            z.object({
              field: z.string().min(1).describe('A field already on the layout.'),
              section: z
                .string()
                .optional()
                .describe('The section to move it to, by its label; default the one it is in.'),
              column: z
                .number()
                .int()
                .min(1)
                .max(4)
                .optional()
                .describe('The column to put it at the end of: 1 is the left.'),
              before: z.string().optional().describe('A field in that section to put it above.'),
              after: z.string().optional().describe('A field in that section to put it below.'),
            })
          )
          .max(50)
          .optional()
          .describe(
            'Fields to move — to another section, or to a place in a section (a column, or before or after another field); each keeps how it behaves. Moves apply in order.'
          ),
        setBehavior: z
          .array(
            z.object({
              field: z.string().min(1).describe('A field already on the layout.'),
              behavior: z.enum(['Edit', 'Required', 'Readonly']),
            })
          )
          .max(50)
          .optional()
          .describe('Fields to make editable, required or read only on this layout.'),
        renameSections: z
          .array(z.object({ section: z.string().min(1), label: z.string().min(1).max(80) }))
          .max(10)
          .optional()
          .describe('Sections to rename, by their current label.'),
        removeSections: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe(
            'Sections to take off, by label. The fields in one leave the layout with it: move the ones to keep first.'
          ),
        addRelatedLists: z
          .array(
            z.object({
              relatedList: z
                .string()
                .min(1)
                .describe(
                  'A child relationship of the object (Visit_Notes__r, from salesforce_admin_describe_object), or the list’s own name in layout metadata (RelatedContactList, Child__c.Lookup__c).'
                ),
              fields: z
                .array(z.string().min(1))
                .max(10)
                .optional()
                .describe(
                  'Its columns, as layout metadata names them: custom fields by API name (Due__c), standard ones by their code (NAME). Default Salesforce’s own.'
                ),
            })
          )
          .max(10)
          .optional()
          .describe('Related lists to show, after those already on the layout.'),
        removeRelatedLists: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe('Related lists to take off, as salesforce_admin_get_layout names them.'),
        setRelatedListColumns: z
          .array(
            z.object({
              relatedList: z.string().min(1).describe('A related list already on the layout.'),
              fields: z
                .array(z.string().min(1))
                .min(1)
                .max(10)
                .describe('Its columns from now on, in order, as layout metadata names them.'),
            })
          )
          .max(10)
          .optional()
          .describe('Related lists already on the layout whose columns to replace.'),
        addButtons: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Custom buttons or links of the object to show, by API name.'),
        removeButtons: z.array(z.string().min(1)).max(20).optional(),
        addActions: z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .describe(
                  'The action’s name: Object.Action_Name for an object’s quick action, a global action’s name, or a standard button (Edit, Delete).'
                ),
              type: z.enum(LAYOUT_ACTION_TYPES).optional().describe('Default QuickAction.'),
            })
          )
          .max(20)
          .optional()
          .describe(
            'Actions for the Lightning and mobile action bar. A layout with no list of its own shows Salesforce’s defaults; adding one replaces them with only what is listed, so name every action to keep.'
          ),
        removeActions: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Actions to take off the Lightning and mobile action bar.'),
        assignTo: z
          .array(
            z.object({
              profile: z.string().min(1).describe('The profile’s name ("Standard User").'),
              recordType: z
                .string()
                .optional()
                .describe(
                  'The record type (API name or label) the profile sees this layout for; default records with no record type (the master).'
                ),
            })
          )
          .max(20)
          .optional()
          .describe(
            'Profiles that see this layout from now on, each in place of the layout it sees today.'
          ),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);

      // Fields named must exist; the layout keeps the org's own spelling.
      const spelled = (field: string) =>
        describe.fields.find((f) => f.name.toLowerCase() === field.toLowerCase())?.name;
      const unknown: string[] = [];
      const known = (field: string): string => {
        const name = spelled(field);
        if (!name) unknown.push(field);
        return name ?? field;
      };
      // A related list named by the object's child relationship is spelled
      // as layout metadata spells a custom one: Child__c.Lookup__c. Any other
      // name goes as given, for Salesforce's validation to check.
      const relatedListName = (ref: string): string => {
        const rel = (describe.childRelationships ?? []).find(
          (r) => r.relationshipName?.toLowerCase() === ref.trim().toLowerCase()
        );
        return rel && /__c$/i.test(rel.field) ? `${rel.childSObject}.${rel.field}` : ref.trim();
      };
      const changes = {
        add: (args.add ?? []).map((a) => ({ ...a, field: known(a.field) })),
        remove: args.remove ?? [],
        addSections: (args.addSections ?? []).map((section) => ({
          ...section,
          fields: (section.fields ?? []).map((f) => ({ ...f, field: known(f.field) })),
        })),
        move: args.move ?? [],
        setBehavior: args.setBehavior ?? [],
        renameSections: args.renameSections ?? [],
        removeSections: args.removeSections ?? [],
        addRelatedLists: (args.addRelatedLists ?? []).map((related) => ({
          ...related,
          relatedList: relatedListName(related.relatedList),
        })),
        removeRelatedLists: (args.removeRelatedLists ?? []).map(relatedListName),
        setRelatedListColumns: (args.setRelatedListColumns ?? []).map((related) => ({
          ...related,
          relatedList: relatedListName(related.relatedList),
        })),
        addButtons: args.addButtons ?? [],
        removeButtons: args.removeButtons ?? [],
        addActions: args.addActions ?? [],
        removeActions: args.removeActions ?? [],
      };
      if (unknown.length > 0) {
        return errText(
          `Nothing was proposed: ${describe.name} has no field ${unknown.join(', ')} that you can see.`
        );
      }
      const layoutChanges = Object.values(changes).reduce((sum, part) => sum + part.length, 0);
      const assignTo = args.assignTo ?? [];
      if (layoutChanges + assignTo.length === 0) {
        return errText(
          'Nothing was proposed: say what to add, move, remove or change on the layout, or which profiles see it.'
        );
      }

      const files: Record<string, string> = {};
      const members: PackageMember[] = [];
      const components: ComponentView[] = [];
      const preconditions: Precondition[] = [];
      const summary: string[] = [];
      let layoutName: string;
      let layoutFullName: string;
      let layoutId: string | null = null;
      if (layoutChanges > 0) {
        const part = await planLayoutChange(context, access, describe.name, args.layout, changes);
        if (typeof part === 'string') return errText(`Nothing was proposed: ${part}`);
        files[part.path] = part.content;
        members.push(part.member);
        components.push(part.component);
        preconditions.push(part.precondition);
        summary.push(...part.summary.map((line) => `•${line.slice(1)}`));
        layoutName = part.name;
        layoutFullName = part.member.member;
      } else {
        const live = await readLayout(context, access, describe.name, args.layout);
        if (typeof live === 'string') return errText(`Nothing was proposed: ${live}`);
        layoutName = live.name;
        layoutFullName = live.fullName;
        layoutId = live.id;
      }

      if (assignTo.length > 0) {
        const errors: string[] = [];
        const needsTypes = assignTo.some((entry) => entry.recordType?.trim());
        const types = needsTypes ? await listRecordTypes(context, access, describe.name) : [];
        if (typeof types === 'string') return errText(`Nothing was proposed: ${types}`);
        if (layoutId === null) {
          const layouts = await listLayouts(context, access, describe.name);
          layoutId =
            typeof layouts === 'string'
              ? ''
              : (layouts.find((l) => l.name === layoutName)?.id ?? '');
        }
        const table = await entityKey(context, access, describe.name);
        const byProfile = new Map<
          string,
          { name: string; assignments: { layout: string; recordType?: string }[]; rows: string[] }
        >();
        for (const entry of assignTo) {
          const profile = await readProfile(context, access, entry.profile);
          if (typeof profile === 'string') {
            errors.push(profile);
            continue;
          }
          const recordType = entry.recordType?.trim()
            ? findRecordType(types, entry.recordType)
            : null;
          if (typeof recordType === 'string') {
            errors.push(`${describe.name}: ${recordType}`);
            continue;
          }
          // What the profile sees there today, to refuse a change that
          // changes nothing; an unreadable answer is not a reason to stop.
          const seen = table
            ? await toolingQuery(
                context,
                access,
                `SELECT LayoutId, RecordTypeId FROM ProfileLayout WHERE TableEnumOrId = ${soqlString(table)} AND ProfileId = ${soqlString(profile.id)}`
              )
            : null;
          const current = seen?.ok
            ? seen.records.find((row) =>
                recordType ? str(row.RecordTypeId) === recordType.id : !str(row.RecordTypeId)
              )
            : undefined;
          const where = recordType ? `${recordType.label} records` : 'records with no record type';
          if (current && layoutId && str(current.LayoutId) === layoutId) {
            errors.push(`${profile.name} already sees “${layoutName}” for ${where}.`);
            continue;
          }
          const held = byProfile.get(profile.fullName) ?? {
            name: profile.name,
            assignments: [],
            rows: [],
          };
          held.assignments.push({
            layout: layoutFullName,
            ...(recordType ? { recordType: `${describe.name}.${recordType.developerName}` } : {}),
          });
          held.rows.push(where);
          byProfile.set(profile.fullName, held);
        }
        if (errors.length > 0)
          return errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);
        for (const [fullName, held] of byProfile) {
          files[`profiles/${metadataFileName(fullName)}.profile`] = profileLayoutFile(
            held.assignments
          );
          members.push({ type: 'Profile', member: fullName });
          components.push({
            type: 'Profile',
            name: held.name,
            action: 'update',
            rows: held.rows.map((where) => ({
              label: `Layout for ${where}`,
              value: layoutName,
            })),
          });
          summary.push(`• ${held.name} sees “${layoutName}” for ${held.rows.join(' and ')}`);
        }
      }

      files['package.xml'] = packageXml(members);
      return proposeAndValidate(context, access, {
        kind: LAYOUT_KIND,
        title:
          layoutChanges > 0
            ? `${describe.label}: change the layout “${layoutName}”`
            : `${describe.label}: give profiles the layout “${layoutName}”`,
        reason: args.reason,
        replaces: args.replaces,
        payload: { files, members, components, preconditions, dataSteps: [] },
        summary,
      });
    }
  );

  server.registerTool(
    'salesforce_admin_propose_layout',
    {
      title: 'Salesforce Admin · Act — Propose a new page layout, or deleting one',
      description:
        'Propose a new page layout on an object as a copy of one it has (create), to then ' +
        'change with salesforce_admin_propose_layout_changes and give to profiles — or propose ' +
        'deleting a layout no profile uses (delete). The person reviews and applies it from the ' +
        'link this returns. A deleted layout cannot be brought back from Renkei.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        object: objectField,
        create: z
          .object({
            name: z.string().min(1).max(80).describe('The new layout’s name.'),
            copyFrom: z
              .string()
              .optional()
              .describe('The layout to copy; default the object’s only layout.'),
          })
          .optional(),
        delete: z.string().optional().describe('In place of create: the layout to delete.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      if (Boolean(args.create) === Boolean(args.delete)) {
        return errText('Name either create (a new layout) or delete (a layout to delete).');
      }
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);

      if (args.create) {
        const name = args.create.name.trim();
        // A layout's full name is Object-Name; these would break it or its file.
        if (!/^[^\\/:*?"<>|]+$/.test(name)) {
          return errText(
            'Nothing was proposed: a layout’s name cannot hold \\ / : * ? " < > or |.'
          );
        }
        const layouts = await listLayouts(context, access, describe.name);
        if (typeof layouts === 'string') return errText(layouts);
        if (layouts.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
          return errText(`Nothing was proposed: ${describe.name} already has a layout “${name}”.`);
        }
        const source = await readLayout(context, access, describe.name, args.create.copyFrom);
        if (typeof source === 'string') return errText(`Nothing was proposed: ${source}`);
        const fullName = `${describe.name}-${name}`;
        const members: PackageMember[] = [{ type: 'Layout', member: fullName }];
        const sections = layoutSections(source.metadata).filter((section) =>
          section.columns.some((column) => column.length > 0)
        );
        return proposeAndValidate(context, access, {
          kind: LAYOUT_KIND,
          title: `${describe.label}: new layout “${name}”`,
          reason: args.reason,
          replaces: args.replaces,
          payload: {
            files: {
              'package.xml': packageXml(members),
              [`layouts/${metadataFileName(fullName)}.layout`]: metadataFile(
                'Layout',
                source.metadata
              ),
            },
            members,
            components: [
              {
                type: 'Layout',
                name: fullName,
                action: 'create',
                rows: [
                  { label: 'Copied from', value: source.name },
                  ...sections.map((section) => ({
                    label: 'Reads',
                    value: `${section.label}: ${section.columns.map((c) => c.join(', ') || '—').join(' | ')}`,
                  })),
                ],
              },
            ],
            preconditions: [{ kind: 'layout-absent', object: describe.name, layout: name }],
            dataSteps: [],
          },
          summary: [
            `• New layout “${name}” on ${describe.name}, a copy of “${source.name}”.`,
            'No profile sees it yet: give it to profiles with salesforce_admin_propose_layout_changes (assignTo) once it is applied.',
          ],
        });
      }

      const live = await readLayout(context, access, describe.name, args.delete);
      if (typeof live === 'string') return errText(`Nothing was proposed: ${live}`);
      // Salesforce refuses to delete a layout a profile still sees; say who, up front.
      const table = await entityKey(context, access, describe.name);
      const used = table
        ? await toolingQuery(
            context,
            access,
            `SELECT Profile.Name, RecordType.Name FROM ProfileLayout WHERE TableEnumOrId = ${soqlString(table)} AND LayoutId = ${soqlString(live.id)} LIMIT 200`
          )
        : null;
      if (used?.ok && used.records.length > 0) {
        const users = used.records.map((row) => {
          const profile = str(rec(row.Profile).Name) || 'a profile';
          const recordType = str(rec(row.RecordType).Name);
          return recordType ? `${profile} (${recordType})` : profile;
        });
        return errText(
          `Nothing was proposed: “${live.name}” is still the layout for ${users.slice(0, 12).join(', ')}${users.length > 12 ? ` and ${users.length - 12} more` : ''}. Give them another layout first (salesforce_admin_propose_layout_changes, assignTo on that layout), then delete this one.`
        );
      }
      const members: PackageMember[] = [{ type: 'Layout', member: live.fullName }];
      return proposeAndValidate(context, access, {
        kind: LAYOUT_KIND,
        title: `${describe.label}: delete the layout “${live.name}”`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          // A destructive deploy: an empty manifest, and what goes.
          files: {
            'package.xml': packageXml([]),
            'destructiveChanges.xml': packageXml(members),
          },
          members,
          components: [
            {
              type: 'Layout',
              name: live.fullName,
              action: 'delete',
              rows: [
                { label: 'Used by', value: used?.ok ? 'no profile' : 'could not be read' },
                ...layoutSections(live.metadata)
                  .filter((section) => section.columns.some((column) => column.length > 0))
                  .map((section) => ({
                    label: 'Held',
                    value: `${section.label}: ${section.columns.map((c) => c.join(', ') || '—').join(' | ')}`,
                  })),
              ],
            },
          ],
          preconditions: [
            {
              kind: 'layout-unchanged',
              object: describe.name,
              layout: live.name,
              fingerprint: live.fingerprint,
            },
          ],
          dataSteps: [],
        },
        summary: [
          `• Delete the layout “${live.name}” from ${describe.name}. It cannot be brought back from Renkei.`,
        ],
      });
    }
  );
}
