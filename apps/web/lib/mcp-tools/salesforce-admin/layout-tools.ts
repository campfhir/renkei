/**
 * Page layouts: reading an object's layouts (which profiles and record
 * types use each, and one layout's sections field by field), and proposing
 * a change to one — fields placed or taken off, new sections. A layout
 * deploys whole, so a proposal carries the live layout with only its
 * changes merged in (layout-plan.ts), and applying it is refused if anyone
 * edited the layout since it was read.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { layoutSections, packageXml, soqlString } from '@renkei/connector-salesforce';
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
} from '@/lib/salesforce-admin/plan';
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
        'that layout’s sections and the fields in each column, top to bottom. Read this before ' +
        'proposing layout changes, or placing new fields on a layout.',
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
      return textResult(
        [
          `Layout “${live.name}” on ${describe.name} (${live.fullName})`,
          usedLine(live.id),
          '',
          ...sections.flatMap((section, index) => [
            `${index + 1}. ${section.label || '(no heading)'} — ${section.columns.length} column${section.columns.length === 1 ? '' : 's'}`,
            ...section.columns.map(
              (column, c) => `   Column ${c + 1}: ${column.length ? column.join(', ') : '(empty)'}`
            ),
          ]),
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
        'first with fields), fields to take off, and new sections with their fields. The ' +
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
      const changes = {
        add: (args.add ?? []).map((a) => ({ ...a, field: known(a.field) })),
        remove: args.remove ?? [],
        addSections: (args.addSections ?? []).map((section) => ({
          ...section,
          fields: (section.fields ?? []).map((f) => ({ ...f, field: known(f.field) })),
        })),
      };
      if (unknown.length > 0) {
        return errText(
          `Nothing was proposed: ${describe.name} has no field ${unknown.join(', ')} that you can see.`
        );
      }
      if (changes.add.length + changes.remove.length + changes.addSections.length === 0) {
        return errText('Nothing was proposed: say what to add, remove, or which sections to add.');
      }

      const part = await planLayoutChange(context, access, describe.name, args.layout, changes);
      if (typeof part === 'string') return errText(`Nothing was proposed: ${part}`);
      const members = [part.member];
      return proposeAndValidate(context, access, {
        kind: LAYOUT_KIND,
        title: `${describe.label}: change the layout “${part.name}”`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files: { 'package.xml': packageXml(members), [part.path]: part.content },
          members,
          components: [part.component],
          preconditions: [part.precondition],
          dataSteps: [],
        },
        summary: part.summary.map((line) => `•${line.slice(1)}`),
      });
    }
  );
}
