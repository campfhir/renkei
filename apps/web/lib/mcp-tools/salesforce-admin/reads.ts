/**
 * The salesforce_admin_ read tools: who the admin connection is and what it
 * may do in Setup, an object's schema as a builder needs it, one field's
 * whole definition and where it is used, an object's validation rules with
 * their formulas, and the person's own change requests. Every one runs as
 * the person, so Salesforce decides what of the org's setup they can see.
 *
 * Reads come from the sObject describe, FieldDefinition, and the Tooling API
 * (`/tooling/query`: ValidationRule, CustomField and its `Metadata`, which
 * needs a one-row query, and MetadataComponentDependency for "where is this
 * used"), all at the pinned v68.0.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { soqlString, summarizeDescribe, takesChanges } from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import {
  errText,
  json,
  rec,
  sfQuery,
  str,
  textResult,
  type SalesforceAccess,
} from '../salesforce/client';
import { resolveObject } from '../salesforce/schema';
import { limitField, objectField } from '../salesforce/fields';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import { readValidationRule, toolingQuery } from '@/lib/salesforce-admin/plan';
import { listChangeRequests, stateOf } from '@/lib/salesforce-admin/change-requests';
import { reviewPrefix } from './review-link';

const PERMISSIONS: [string, string][] = [
  ['PermissionsViewSetup', 'View Setup and Configuration'],
  ['PermissionsCustomizeApplication', 'Customize Application'],
  ['PermissionsModifyMetadata', 'Modify Metadata Through Metadata API Functions'],
  ['PermissionsModifyAllData', 'Modify All Data'],
  ['PermissionsManageUsers', 'Manage Users'],
  ['PermissionsAuthorApex', 'Author Apex'],
];

/** Whether this connection's org takes change requests, in words. */
export async function changesHere(access: SalesforceAccess): Promise<string> {
  const org = (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).find(
    (candidate) => candidate.key === access.connector
  );
  if (!org) return 'unknown';
  return takesChanges(org)
    ? 'change requests can be proposed and applied here'
    : 'read only here: a production org that does not take change requests (build in a sandbox)';
}

/** The object's id the Tooling API keys fields by: its name for standard objects, 01I… for custom. */
async function entityKey(
  context: MCPToolContext,
  access: SalesforceAccess,
  object: string
): Promise<string | null> {
  const found = await sfQuery(
    context,
    access,
    `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${soqlString(object)} LIMIT 1`
  );
  return found.ok ? str(found.records[0]?.DurableId) || null : null;
}

export function registerAdminReadTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_check_access',
    {
      title: 'Salesforce Admin · Read — What may this connection do in Setup?',
      description:
        'Who the admin connection acts as, which org (sandbox or production), whether change ' +
        'requests can be applied there, and the person’s own Setup permissions (Customize ' +
        'Application, Modify Metadata…) — what Salesforce will let a validation and an apply do. ' +
        'Call this first when a proposal fails on permissions.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const [perms, org] = await Promise.all([
        sfQuery(
          context,
          access,
          `SELECT ${PERMISSIONS.map(([field]) => field).join(', ')} FROM UserPermissionAccess LIMIT 1`
        ),
        sfQuery(context, access, 'SELECT Name, IsSandbox, OrganizationType FROM Organization'),
      ]);
      const granted = perms.ok ? rec(perms.records[0]) : {};
      const organization = org.ok ? rec(org.records[0]) : {};
      return textResult(
        [
          `Connected as ${access.username} in ${str(organization.Name) || access.connectorName} (${access.orgId})` +
            (access.sandbox ? ' — a sandbox' : ' — production') +
            (str(organization.OrganizationType) ? `, ${str(organization.OrganizationType)}` : ''),
          `Org address: ${access.instanceUrl}`,
          `Here: ${await changesHere(access)}.`,
          perms.ok
            ? `Your Setup permissions: ${
                PERMISSIONS.filter(([field]) => granted[field] === true)
                  .map(([, label]) => label)
                  .join(', ') || 'none of the ones building needs'
              }.`
            : `Your Setup permissions could not be read: ${perms.error}`,
          `This connection may: ${(context.salesforceAdminScopes ?? []).join(', ') || 'nothing'}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_admin_describe_object',
    {
      title: 'Salesforce Admin · Read — An object’s schema, for building',
      description:
        'An object’s fields (type, length, required, help text, picklist values, lookups), record ' +
        'types, child relationships and validation rules — what to read before proposing a field ' +
        'or a rule, so names do not clash and formulas use the right API names.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ object: objectField }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const rules = await toolingQuery(
        context,
        access,
        `SELECT ValidationName, Active, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = ${soqlString(describe.name)} ORDER BY ValidationName`
      );
      return textResult(
        json({
          ...summarizeDescribe(describe),
          validationRules: rules.ok
            ? rules.records.map((rule) => ({
                name: str(rule.ValidationName),
                active: rule.Active === true,
                message: str(rule.ErrorMessage),
              }))
            : { error: rules.error },
        })
      );
    }
  );

  server.registerTool(
    'salesforce_admin_get_field',
    {
      title: 'Salesforce Admin · Read — One field, and where it is used',
      description:
        'A field’s whole definition — type, length, formula, default, help text, whether it is ' +
        'required, unique or an external id, history tracking — and, for a custom field, what ' +
        'uses it (layouts, flows, Apex, reports…) from the org’s dependency records.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField,
        field: z.string().min(1).describe('The field’s API name (Outcome__c, Email).'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const definition = await sfQuery(
        context,
        access,
        `SELECT QualifiedApiName, Label, DataType, Description, IsNillable, IsIndexed, IsCalculated, IsFieldHistoryTracked, ReferenceTo, RelationshipName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ${soqlString(describe.name)} AND QualifiedApiName = ${soqlString(args.field.trim())} LIMIT 1`
      );
      if (!definition.ok) return errText(definition.error);
      const row = definition.records[0];
      if (!row) return errText(`${describe.name} has no field ${args.field}.`);
      const out: Record<string, unknown> = { object: describe.name, ...row };
      const custom = /__c$/i.test(args.field.trim());
      if (custom) {
        const table = await entityKey(context, access, describe.name);
        const developerName = args.field.trim().replace(/__c$/i, '');
        if (table) {
          const field = await toolingQuery(
            context,
            access,
            `SELECT Id, Metadata FROM CustomField WHERE TableEnumOrId = ${soqlString(table)} AND DeveloperName = ${soqlString(developerName)} LIMIT 1`
          );
          if (field.ok && field.records[0]) {
            out.metadata = field.records[0].Metadata;
            const id = str(field.records[0].Id);
            const uses = await toolingQuery(
              context,
              access,
              `SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = ${soqlString(id)} LIMIT 200`
            );
            out.usedBy = uses.ok
              ? uses.records.map(
                  (use) => `${str(use.MetadataComponentType)} ${str(use.MetadataComponentName)}`
                )
              : { error: uses.error };
          }
        }
      }
      return textResult(json(out));
    }
  );

  server.registerTool(
    'salesforce_admin_list_validation_rules',
    {
      title: 'Salesforce Admin · Read — An object’s validation rules',
      description:
        'Every validation rule on an object, active or not, with its formula, error message and ' +
        'the field the message shows on — read before proposing a rule, or to explain why a save ' +
        'is blocked.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ object: objectField, limit: limitField(50, 25) }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const rules = await toolingQuery(
        context,
        access,
        `SELECT ValidationName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = ${soqlString(describe.name)} ORDER BY ValidationName LIMIT ${args.limit ?? 25}`
      );
      if (!rules.ok) return errText(rules.error);
      if (rules.records.length === 0)
        return textResult(`${describe.name} has no validation rules.`);
      // The formula is in Metadata, which the Tooling API returns one rule at a time.
      const lines: string[] = [];
      for (const rule of rules.records) {
        const live = await readValidationRule(
          context,
          access,
          describe.name,
          str(rule.ValidationName)
        );
        if (!live || typeof live === 'string') continue;
        lines.push(
          `${live.name} — ${live.active ? 'active' : 'inactive'}\n  formula: ${live.formula}\n  message: ${live.message}` +
            (live.errorDisplayField ? ` (on ${live.errorDisplayField})` : '') +
            (live.description ? `\n  ${live.description}` : '')
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_admin_list_change_requests',
    {
      title: 'Salesforce Admin · Read — Your change requests',
      description:
        'The person’s Salesforce admin change requests, newest first: what each changes, whether ' +
        'Salesforce validated it, whether it is applied, and its review link.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        pendingOnly: z.boolean().optional().describe('Only those still waiting to be applied.'),
        limit: limitField(50, 20),
      }),
    },
    async (args) => {
      if (!context.subject) return errText('No signed-in identity on this request.');
      const db =
        context.db ??
        (() => {
          const result = getDatabase();
          return result.ok ? result.val : null;
        })();
      if (!db) return errText('Could not read your change requests.');
      const changes = await listChangeRequests(db, context.subject, {
        limit: args.limit ?? 20,
        pendingOnly: args.pendingOnly,
      });
      if (changes.length === 0) return textResult('No change requests.');
      const prefix = reviewPrefix(context);
      return textResult(
        changes
          .map((change) => {
            const validation = change.validation;
            const checked = !validation
              ? 'not validated'
              : 'error' in validation
                ? `validation could not run: ${validation.error}`
                : !validation.done
                  ? 'validating'
                  : validation.success
                    ? 'validated'
                    : `validation failed (${validation.failures.length} error(s))`;
            return `${change.title} — ${stateOf(change)}, ${checked}, in ${change.connectorKey}\n  ${prefix}${change.id}`;
          })
          .join('\n')
      );
    }
  );
}
