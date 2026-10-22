/**
 * The salesforce_admin_ proposals. Each reads the live metadata it is about
 * to change, builds the exact deployment (@renkei/connector-salesforce
 * metadata.ts), stores it as a change request, and runs Salesforce's
 * check-only deploy against it — Salesforce compiles the formulas, checks
 * every reference and changes nothing — then answers with what Salesforce
 * said and the review link. Nothing here applies a change: that is the
 * person's, in their browser (docs/salesforce-connectors-design.md,
 * "Confirm rule: change requests, applied in the browser").
 *
 * A proposal in an org that does not take changes (a production org whose
 * connector does not allow them) is refused before anything is stored.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildObjectChildrenPackage,
  checkFieldSpec,
  checkValidationRuleSpec,
  packageXml,
  soqlString,
  type FieldSpec,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, sfQuery, str } from '../salesforce/client';
import { globalDescribe, resolveObject } from '../salesforce/schema';
import { objectField } from '../salesforce/fields';
import {
  FIELDS_KIND,
  readValidationRule,
  resolvePermissionSet,
  VALIDATION_RULE_KIND,
  type ComponentView,
  type DataStep,
  type Precondition,
} from '@/lib/salesforce-admin/plan';
import {
  fieldInput,
  fieldRows,
  proposeAndValidate,
  reasonField,
  refusesChanges,
  replacesField,
} from './shared';
import { planLayoutChange } from './layout-plan';

/** A permission set to give access to what a proposal creates. */
export const grantToField = z
  .array(
    z.object({
      permissionSet: z.string().min(1).describe('The permission set’s API name or label.'),
      edit: z.boolean().optional().describe('Edit as well as read (default read only).'),
    })
  )
  .max(10)
  .optional();

export function registerAdminProposalTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_propose_fields',
    {
      title: 'Salesforce Admin · Act — Propose new fields',
      description:
        'Propose up to 20 new custom fields on one object — text, long text, number, currency, ' +
        'percent, date, date/time, checkbox, email, phone, URL, picklist, multi-select picklist ' +
        'or lookup — optionally giving named permission sets access to them and placing them on ' +
        'named page layouts, in the same change. This stores a change ' +
        'request and has Salesforce validate it (a check-only deploy, which changes nothing); the ' +
        'person reviews and applies it from the link this returns. New fields are invisible to ' +
        'people until a permission set grants them, so name the permission sets.',
      // A proposal writes a change request in Renkei, never to Salesforce —
      // but it is a write, so org read-only mode hides it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        fields: z.array(fieldInput).min(1).max(20),
        grantTo: grantToField.describe(
          'Permission sets to give access to the new fields once they deploy.'
        ),
        addToLayouts: z
          .array(
            z.object({
              layout: z
                .string()
                .min(1)
                .describe('The page layout’s name (salesforce_admin_get_layout lists them).'),
              section: z
                .string()
                .optional()
                .describe('The section’s label; default the first with fields.'),
            })
          )
          .max(5)
          .optional()
          .describe('Page layouts to place the new fields on, in the same change.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      // Placing fields on layouts is the layouts capability's; applying
      // checks it again on the one connection the change runs on.
      if (
        (args.addToLayouts ?? []).length > 0 &&
        !(context.salesforceAdminScopes ?? []).includes('sfa-layouts')
      ) {
        return errText(
          'Placing fields on layouts needs “Propose page layout changes”, which your connection does not allow. Propose the fields without addToLayouts.'
        );
      }
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);

      // Every existing field, whoever can see it — the describe shows only
      // the person's own field-level access.
      const existing = await sfQuery(
        context,
        access,
        `SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ${soqlString(describe.name)}`
      );
      if (!existing.ok) return errText(existing.error);
      const taken = existing.records.map((row) => str(row.QualifiedApiName));

      const objects = await globalDescribe(context, access);
      if (typeof objects === 'string') return errText(objects);
      const specs: FieldSpec[] = [];
      const errors: string[] = [];
      for (const field of args.fields) {
        const checked = checkFieldSpec({ ...field, object: describe.name }, [
          ...taken,
          ...specs.map((spec) => spec.apiName),
        ]);
        if (!checked.ok) {
          errors.push(...checked.errors.map((error) => `${field.label}: ${error}`));
          continue;
        }
        if (
          checked.value.referenceTo &&
          !objects.some((o) => o.name.toLowerCase() === checked.value.referenceTo?.toLowerCase())
        ) {
          errors.push(
            `${field.label}: there is no object ${checked.value.referenceTo} to point at.`
          );
          continue;
        }
        specs.push(checked.value);
      }
      if (errors.length > 0)
        return errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);

      const steps: DataStep[] = [];
      for (const grant of args.grantTo ?? []) {
        const permissionSet = await resolvePermissionSet(context, access, grant.permissionSet);
        if (typeof permissionSet === 'string') return errText(permissionSet);
        for (const spec of specs) {
          // A required field is visible and editable to everyone already;
          // Salesforce refuses field permissions on one.
          if (spec.required) continue;
          steps.push({
            kind: 'field-permission',
            permissionSetId: permissionSet.id,
            permissionSetName: permissionSet.name,
            object: describe.name,
            field: spec.apiName,
            read: true,
            edit: grant.edit === true,
          });
        }
      }

      const built = buildObjectChildrenPackage({ fields: specs });
      const components: ComponentView[] = specs.map((spec) => ({
        type: 'CustomField',
        name: `${describe.name}.${spec.apiName}`,
        action: 'create',
        rows: fieldRows(spec),
      }));
      const preconditions: Precondition[] = specs.map((spec) => ({
        kind: 'field-absent',
        object: describe.name,
        field: spec.apiName,
      }));
      const layoutLines: string[] = [];
      for (const placement of args.addToLayouts ?? []) {
        const part = await planLayoutChange(context, access, describe.name, placement.layout, {
          add: specs.map((spec) => ({
            field: spec.apiName,
            section: placement.section,
            behavior: spec.required ? 'Required' : 'Edit',
          })),
        });
        if (typeof part === 'string') return errText(`Nothing was proposed: ${part}`);
        built.files[part.path] = part.content;
        built.members.push(part.member);
        components.push(part.component);
        preconditions.push(part.precondition);
        layoutLines.push(...part.summary);
      }
      built.files['package.xml'] = packageXml(built.members);
      const names = specs.map((spec) => spec.label);
      return proposeAndValidate(context, access, {
        kind: FIELDS_KIND,
        title: `${describe.label}: add ${names.length === 1 ? `the field ${names[0]}` : `${names.length} fields (${names.join(', ')})`}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: { ...built, components, preconditions, dataSteps: steps },
        summary: [
          ...specs.map(
            (spec) => `• ${describe.name}.${spec.apiName} — ${spec.type}, “${spec.label}”`
          ),
          ...(layoutLines.length > 0 ? ['On layouts:', ...layoutLines] : ['On no page layout.']),
          ...(steps.length > 0
            ? [
                `Then: ${[...new Set(steps.map((g) => `${g.permissionSetName} (${'edit' in g && g.edit ? 'read and edit' : 'read'})`))].join(', ')} get access to them.`,
              ]
            : [
                'No permission set is given access: people will not see these fields until one is.',
              ]),
        ],
      });
    }
  );

  server.registerTool(
    'salesforce_admin_propose_validation_rule',
    {
      title: 'Salesforce Admin · Act — Propose a validation rule',
      description:
        'Propose a new validation rule on an object, or a change to an existing one (by name): ' +
        'its formula (true when the record is wrong), the message people see, the field it shows ' +
        'on, and whether it is active. Salesforce checks the formula in a validation deploy that ' +
        'changes nothing; the person reviews and applies it from the link this returns. Read the ' +
        'object’s fields and rules first (salesforce_admin_describe_object, ' +
        'salesforce_admin_list_validation_rules).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        name: z
          .string()
          .optional()
          .describe(
            'The rule’s API name; an existing rule’s name changes that rule. Default from label.'
          ),
        label: z
          .string()
          .optional()
          .describe('A short name, when proposing a new rule without one.'),
        formula: z
          .string()
          .min(1)
          .describe('The error condition formula: true when the save must be blocked.'),
        message: z
          .string()
          .min(1)
          .max(255)
          .describe('The message people see when it blocks a save.'),
        errorDisplayField: z
          .string()
          .optional()
          .describe('The field the message shows on; default the top of the page.'),
        active: z.boolean().optional().describe('Default true.'),
        description: z.string().max(1000).optional(),
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
      const checked = checkValidationRuleSpec({ ...args, object: describe.name });
      if (!checked.ok)
        return errText(`Nothing was proposed:\n${checked.errors.map((e) => `• ${e}`).join('\n')}`);
      const rule = checked.value;
      if (
        rule.errorDisplayField &&
        !describe.fields.some((f) => f.name.toLowerCase() === rule.errorDisplayField?.toLowerCase())
      ) {
        return errText(
          `${describe.name} has no field ${rule.errorDisplayField} to show the message on.`
        );
      }

      const live = await readValidationRule(context, access, describe.name, rule.name);
      if (typeof live === 'string') return errText(live);
      const built = buildObjectChildrenPackage({ rules: [rule] });
      const row = (label: string, value: string, from: string | undefined) =>
        live && from !== undefined && from !== value ? { label, value, from } : { label, value };
      const component: ComponentView = {
        type: 'ValidationRule',
        name: `${describe.name}.${rule.name}`,
        action: live ? 'update' : 'create',
        rows: [
          row(
            'Active',
            rule.active ? 'yes' : 'no',
            live ? (live.active ? 'yes' : 'no') : undefined
          ),
          row('Formula', rule.formula, live?.formula),
          row('Message', rule.message, live?.message),
          row(
            'Shown on',
            rule.errorDisplayField ?? 'top of the page',
            live ? live.errorDisplayField || 'top of the page' : undefined
          ),
          ...(rule.description || live?.description
            ? [row('Description', rule.description ?? '', live?.description)]
            : []),
        ],
      };
      const precondition: Precondition = live
        ? {
            kind: 'rule-unchanged',
            object: describe.name,
            rule: rule.name,
            fingerprint: live.fingerprint,
          }
        : { kind: 'rule-absent', object: describe.name, rule: rule.name };
      return proposeAndValidate(context, access, {
        kind: VALIDATION_RULE_KIND,
        title: `${describe.label}: ${live ? 'change' : 'add'} the validation rule ${rule.name}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          ...built,
          components: [component],
          preconditions: [precondition],
          dataSteps: [],
        },
        summary: [
          `• ${live ? 'Change' : 'New'} rule ${describe.name}.${rule.name}${rule.active ? '' : ' (inactive)'}: blocks a save when ${rule.formula}`,
          `  Message: “${rule.message}”${rule.errorDisplayField ? ` on ${rule.errorDisplayField}` : ''}`,
        ],
      });
    }
  );
}
