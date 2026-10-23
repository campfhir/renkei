/**
 * A new custom object: its name field, sharing and features, its first
 * fields, and a tab — one deployment (@renkei/connector-salesforce
 * changes.ts buildObjectPackage) — then, once it deploys, the named
 * permission sets get access to the records, the tab and the fields, as
 * data steps (lib/salesforce-admin/plan.ts). A new object is invisible to
 * everyone without them, so the proposal says so when none is named.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildObjectPackage, checkObjectSpec, SHARING_MODELS } from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText } from '../salesforce/client';
import { globalDescribe } from '../salesforce/schema';
import {
  objectExists,
  OBJECT_KIND,
  resolvePermissionSet,
  type ComponentView,
  type DataStep,
} from '@/lib/salesforce-admin/plan';
import { grantToField } from './propose';
import {
  fieldInput,
  fieldRows,
  proposeAndValidate,
  reasonField,
  refusesChanges,
  replacesField,
} from './shared';

export function registerAdminObjectTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_propose_object',
    {
      title: 'Salesforce Admin · Act — Propose a new object',
      description:
        'Propose a new custom object with a tab: its label and plural, its name field (text, or ' +
        'an auto-number like V-{0000}), who sees whose records by default (sharing: ReadWrite, ' +
        'Read or Private), activities, history, reports and search, and up to 50 first fields. ' +
        'Name the permission sets to give access to it: a new object is invisible to everyone ' +
        'until one does. Checked by a validation deploy that changes nothing; the person ' +
        'reviews and applies it from the link this returns.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        label: z.string().min(1).max(40).describe('Singular: "Site Visit".'),
        pluralLabel: z.string().max(40).optional().describe('Default the label with an s.'),
        apiName: z
          .string()
          .optional()
          .describe('With or without __c; default from the label (Site_Visit__c).'),
        description: z.string().max(1000).optional(),
        nameField: z
          .object({
            type: z.enum(['Text', 'AutoNumber']),
            label: z.string().max(80).optional().describe('Default "<label> Name".'),
            displayFormat: z
              .string()
              .optional()
              .describe('AutoNumber: like V-{0000} (default from the API name).'),
            startingNumber: z.number().int().min(0).optional(),
          })
          .optional()
          .describe('The record name: typed by people (Text, default) or numbered (AutoNumber).'),
        sharingModel: z
          .enum(SHARING_MODELS)
          .optional()
          .describe(
            'Default access to others’ records: ReadWrite (default), Read, or Private (owner and up the role hierarchy).'
          ),
        activities: z.boolean().optional().describe('Tasks and events (default true).'),
        history: z.boolean().optional().describe('Field history tracking (default false).'),
        reports: z.boolean().optional().describe('Default true.'),
        search: z.boolean().optional().describe('Default true.'),
        tabMotif: z
          .string()
          .optional()
          .describe('The tab’s icon, a Salesforce motif such as "Custom18: Form".'),
        fields: z.array(fieldInput).max(50).optional(),
        grantTo: grantToField.describe(
          'Permission sets to give access once it deploys: read, or (edit) read, create, edit and delete — with the tab and the fields.'
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
      const objects = await globalDescribe(context, access);
      if (typeof objects === 'string') return errText(objects);
      const checked = checkObjectSpec(
        args,
        objects.map((o) => o.name)
      );
      if (!checked.ok)
        return errText(`Nothing was proposed:\n${checked.errors.map((e) => `• ${e}`).join('\n')}`);
      const spec = checked.value;
      // The global describe shows only what the person can see.
      const exists = await objectExists(context, access, spec.apiName);
      if (typeof exists === 'string') return errText(exists);
      if (exists)
        return errText(`Nothing was proposed: there is already an object ${spec.apiName}.`);
      const pointsNowhere = spec.fields.filter(
        (field) =>
          field.referenceTo &&
          !objects.some((o) => o.name.toLowerCase() === field.referenceTo?.toLowerCase())
      );
      if (pointsNowhere.length > 0) {
        return errText(
          `Nothing was proposed:\n${pointsNowhere.map((f) => `• ${f.label}: there is no object ${f.referenceTo} to point at.`).join('\n')}`
        );
      }

      const steps: DataStep[] = [];
      const fieldSteps: DataStep[] = [];
      for (const grant of args.grantTo ?? []) {
        const permissionSet = await resolvePermissionSet(context, access, grant.permissionSet);
        if (typeof permissionSet === 'string') return errText(permissionSet);
        const edit = grant.edit === true;
        const base = { permissionSetId: permissionSet.id, permissionSetName: permissionSet.name };
        steps.push(
          {
            kind: 'object-permission',
            ...base,
            object: spec.apiName,
            read: true,
            create: edit,
            edit,
            delete: edit,
            viewAll: false,
            modifyAll: false,
          },
          { kind: 'tab-visibility', ...base, tab: spec.apiName, visibility: 'DefaultOn' }
        );
        for (const field of spec.fields) {
          if (field.required) continue;
          fieldSteps.push({
            kind: 'field-permission',
            ...base,
            object: spec.apiName,
            field: field.apiName,
            read: true,
            edit,
          });
        }
      }
      // Field access needs the object's first.
      steps.push(...fieldSteps);

      const built = buildObjectPackage(spec);
      const components: ComponentView[] = [
        {
          type: 'CustomObject',
          name: spec.apiName,
          action: 'create',
          rows: [
            { label: 'Label', value: `${spec.label} / ${spec.pluralLabel}` },
            {
              label: 'Record name',
              value:
                spec.nameField.type === 'AutoNumber'
                  ? `${spec.nameField.label}, numbered ${spec.nameField.displayFormat} from ${spec.nameField.startingNumber}`
                  : `${spec.nameField.label}, typed in`,
            },
            { label: 'Sharing', value: spec.sharingModel },
            {
              label: 'Features',
              value:
                [
                  spec.activities && 'activities',
                  spec.history && 'field history',
                  spec.reports && 'reports',
                  spec.search && 'search',
                ]
                  .filter(Boolean)
                  .join(', ') || 'none',
            },
            ...(spec.description ? [{ label: 'Description', value: spec.description }] : []),
          ],
        },
        {
          type: 'CustomTab',
          name: spec.apiName,
          action: 'create',
          rows: [{ label: 'Icon', value: spec.tabMotif }],
        },
        ...spec.fields.map((field): ComponentView => ({
          type: 'CustomField',
          name: `${spec.apiName}.${field.apiName}`,
          action: 'create',
          rows: fieldRows(field),
        })),
      ];
      const sets = [...new Set(steps.map((step) => step.permissionSetName))];
      return proposeAndValidate(context, access, {
        kind: OBJECT_KIND,
        title: `New object ${spec.label} (${spec.apiName})`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          ...built,
          components,
          preconditions: [{ kind: 'object-absent', object: spec.apiName }],
          dataSteps: steps,
        },
        summary: [
          `• ${spec.apiName} — “${spec.label}”, sharing ${spec.sharingModel}, with a tab`,
          ...spec.fields.map((field) => `  ${field.apiName} — ${field.type}, “${field.label}”`),
          sets.length > 0
            ? `Then: ${sets.join(', ')} get access to its records, tab and fields.`
            : 'No permission set is given access: nobody will see this object until one is.',
        ],
      });
    }
  );
}
