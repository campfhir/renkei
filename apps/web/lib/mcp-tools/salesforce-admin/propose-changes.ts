/**
 * Changes to an existing custom field's settings: label, help text,
 * required, a longer length… (a picklist's values: picklist-tools.ts). An
 * existing field deploys as its whole definition, so the proposal reads the
 * live field (the Tooling API's `CustomField.Metadata`), merges only what
 * it changes (@renkei/connector-salesforce changes.ts), and carries the
 * precondition that nobody edited the field since — applying is refused
 * otherwise.
 *
 * Nothing here loses data: a type change, a shorter length and fewer
 * digits are refused, with where to do them instead.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  existingFieldXml,
  mergeFieldChanges,
  objectFileXml,
  packageXml,
  type ChangeRow,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, type SalesforceAccess } from '../salesforce/client';
import { resolveObject } from '../salesforce/schema';
import { objectField } from '../salesforce/fields';
import {
  FIELD_CHANGES_KIND,
  readCustomField,
  type LiveCustomField,
  type MetadataPayload,
} from '@/lib/salesforce-admin/plan';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

const fieldNameField = z
  .string()
  .min(1)
  .describe('The custom field’s API name (…__c); salesforce_admin_describe_object lists them.');

/** The live field to change, or why not. */
export async function liveField(
  context: MCPToolContext,
  access: SalesforceAccess,
  object: string,
  field: string
): Promise<{ object: string; label: string; live: LiveCustomField } | string> {
  const describe = await resolveObject(context, access, object);
  if (typeof describe === 'string') return describe;
  const live = await readCustomField(context, access, describe.name, field.trim());
  if (typeof live === 'string') return live;
  if (!live) return `${describe.name} has no custom field ${field}.`;
  return { object: describe.name, label: describe.label, live };
}

/** The deployment of one existing field, whole, with the change merged in. */
export function fieldPayload(
  object: string,
  live: LiveCustomField,
  metadata: Record<string, unknown>,
  rows: ChangeRow[]
): MetadataPayload {
  const field = live.fullName.split('.').pop() ?? live.fullName;
  const members = [{ type: 'CustomField', member: `${object}.${field}` }];
  return {
    files: {
      'package.xml': packageXml(members),
      [`objects/${object}.object`]: objectFileXml([existingFieldXml(field, metadata)]),
    },
    members,
    components: [{ type: 'CustomField', name: `${object}.${field}`, action: 'update', rows }],
    preconditions: [{ kind: 'field-unchanged', object, field, fingerprint: live.fingerprint }],
    dataSteps: [],
  };
}

export const rowLine = (row: ChangeRow) =>
  row.from !== undefined
    ? `• ${row.label}: ${row.from} → ${row.value}`
    : `• ${row.label}: ${row.value}`;

export function registerAdminChangeTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_propose_field_changes',
    {
      title: 'Salesforce Admin · Act — Propose changes to a field',
      description:
        'Propose changes to an existing custom field: its label, help text, description, ' +
        'whether it is required, a longer length, more digits, visible lines, or its default. ' +
        'Changing a type, a shorter length or fewer digits can lose data and is refused. The ' +
        'change is checked by a validation deploy that changes nothing; the person reviews and ' +
        'applies it from the link this returns. Picklist values: ' +
        'salesforce_admin_propose_picklist_changes.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        field: fieldNameField,
        label: z.string().min(1).max(40).optional(),
        helpText: z.string().max(510).optional().describe('An empty string clears it.'),
        description: z.string().max(1000).optional(),
        required: z.boolean().optional(),
        length: z.number().int().optional().describe('Text and long text: only longer.'),
        visibleLines: z.number().int().optional(),
        precision: z.number().int().optional().describe('Number, Currency, Percent: only more.'),
        scale: z.number().int().optional(),
        defaultValue: z
          .string()
          .optional()
          .describe(
            'A formula or literal as Salesforce takes it ("\'Open\'", "TODAY()"); "" clears.'
          ),
        type: z.string().optional().describe('Not changed here; given only to be refused.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const found = await liveField(context, access, args.object, args.field);
      if (typeof found === 'string') return errText(found);
      const { object, label, live } = found;
      const merged = mergeFieldChanges(live.metadata, {
        label: args.label,
        helpText: args.helpText,
        description: args.description,
        required: args.required,
        length: args.length,
        visibleLines: args.visibleLines,
        precision: args.precision,
        scale: args.scale,
        defaultValue: args.defaultValue,
        type: args.type,
      });
      if (!merged.ok)
        return errText(`Nothing was proposed:\n${merged.errors.map((e) => `• ${e}`).join('\n')}`);
      return proposeAndValidate(context, access, {
        kind: FIELD_CHANGES_KIND,
        title: `${label}: change the field ${live.fullName}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: fieldPayload(object, live, merged.metadata, merged.rows),
        summary: [`${live.fullName}:`, ...merged.rows.map(rowLine)],
      });
    }
  );
}
