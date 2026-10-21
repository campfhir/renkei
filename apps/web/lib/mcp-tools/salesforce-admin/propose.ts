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
import type { Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import {
  buildObjectChildrenPackage,
  checkFieldSpec,
  checkValidationRuleSpec,
  FIELD_TYPES,
  soqlString,
  takesChanges,
  type FieldSpec,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, sfQuery, str, type SalesforceAccess } from '../salesforce/client';
import { globalDescribe, resolveObject } from '../salesforce/schema';
import { objectField } from '../salesforce/fields';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import {
  cancelChangeRequest,
  CHANGE_REQUEST_TTL_HOURS,
  createChangeRequest,
  setValidation,
  validationFrom,
  type Validation,
} from '@/lib/salesforce-admin/change-requests';
import { failureLines, startDeploy, waitForDeploy } from '@/lib/salesforce-admin/deploy';
import {
  FIELDS_KIND,
  readValidationRule,
  resolvePermissionSet,
  VALIDATION_RULE_KIND,
  type ComponentView,
  type FieldGrant,
  type MetadataPayload,
  type Precondition,
} from '@/lib/salesforce-admin/plan';
import { reviewPrefix } from './review-link';

/** How long a proposal waits on Salesforce's validation before answering. */
export const VALIDATION_WAIT_MS = 60_000;

const reasonField = z
  .string()
  .max(2000)
  .optional()
  .describe('Why, in the person’s words — shown on the review page.');

const replacesField = z
  .string()
  .optional()
  .describe('The id of an earlier pending request this one replaces; that one is cancelled.');

function dbOf(context: MCPToolContext): Kysely<DB> | null {
  if (context.db) return context.db;
  const result = getDatabase();
  return result.ok ? result.val : null;
}

/** Why this org takes no proposals, or null. */
async function refusesChanges(access: SalesforceAccess): Promise<string | null> {
  const org = (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).find(
    (candidate) => candidate.key === access.connector
  );
  if (!org) return 'This Salesforce Admin connector is no longer set up.';
  if (takesChanges(org)) return null;
  return (
    `${org.name} is a production org that does not take change requests from Renkei. ` +
    'Propose it in a sandbox and promote it, or ask an organization admin to allow changes on this connector.'
  );
}

function validationLines(validation: Validation): string[] {
  if ('error' in validation) {
    return [`Salesforce could not validate it: ${validation.error}`];
  }
  if (!validation.done) {
    return [
      'Salesforce is still validating it (a check-only deploy); the review page shows the result when it is done.',
    ];
  }
  if (validation.success) {
    return ['Salesforce validated it: a check-only deploy passed and changed nothing.'];
  }
  return [
    'Salesforce’s validation failed — fix these and propose again (replaces: this id):',
    ...failureLines({
      id: validation.deployId,
      done: true,
      status: validation.status,
      success: false,
      checkOnly: true,
      componentsDeployed: 0,
      componentsTotal: 0,
      failures: validation.failures,
      ...(validation.errorMessage ? { errorMessage: validation.errorMessage } : {}),
    }).map((line) => `  • ${line}`),
  ];
}

/** Store the proposal, validate it, and answer with the outcome and the review link. */
async function proposeAndValidate(
  context: MCPToolContext,
  access: SalesforceAccess,
  input: {
    kind: string;
    title: string;
    reason?: string;
    replaces?: string;
    payload: MetadataPayload;
    summary: string[];
  }
) {
  if (!context.subject) return errText('No signed-in identity on this request.');
  const db = dbOf(context);
  if (!db) return errText('Could not store the change request.');
  if (input.replaces) await cancelChangeRequest(db, context.subject, input.replaces);
  const change = await createChangeRequest(db, {
    subject: context.subject,
    agentId: context.agent?.agentId,
    connectorKey: access.connector,
    orgId: access.orgId,
    instanceUrl: access.instanceUrl,
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    payload: input.payload,
  });

  let validation: Validation;
  const started = await startDeploy(context, access, input.payload.files, { checkOnly: true });
  if (!started.ok) {
    validation = { error: started.error, checkedAt: new Date().toISOString() };
  } else {
    const waited = started.outcome.done
      ? { ok: true as const, outcome: started.outcome }
      : await waitForDeploy(context, access, started.outcome.id, VALIDATION_WAIT_MS);
    validation = waited.ok ? validationFrom(waited.outcome) : validationFrom(started.outcome);
  }
  await setValidation(db, change.id, validation);

  const link = `${reviewPrefix(context)}${change.id}`;
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Proposed in ${access.connectorName}${access.sandbox ? ' (sandbox)' : ' (production)'} — nothing has changed in Salesforce yet.`,
          ...input.summary,
          '',
          ...validationLines(validation),
          '',
          `Review and apply: ${link}`,
          `Request ${change.id}; it expires in ${CHANGE_REQUEST_TTL_HOURS} hours. Only the person can apply it, from that page.`,
        ].join('\n'),
      },
    ],
    _meta: actMeta({ url: link }),
  };
}

const fieldInput = z.object({
  label: z.string().min(1).max(40).describe('What people see: "Visit Outcome".'),
  apiName: z
    .string()
    .optional()
    .describe(
      'The API name, with or without __c; default derived from the label (Visit_Outcome__c).'
    ),
  type: z.enum(FIELD_TYPES).describe('The field type.'),
  description: z.string().max(1000).optional().describe('For admins: what it is for.'),
  helpText: z.string().max(510).optional().describe('What people see when they hover the field.'),
  required: z.boolean().optional(),
  unique: z.boolean().optional().describe('Text, Number, Email only.'),
  externalId: z
    .boolean()
    .optional()
    .describe('Text, Number, Email only: an id from another system.'),
  trackHistory: z
    .boolean()
    .optional()
    .describe('Track changes in field history (the object must have history tracking on).'),
  length: z
    .number()
    .int()
    .optional()
    .describe('Text 1–255 (default 255); LongTextArea 256–131,072.'),
  precision: z.number().int().optional().describe('Number, Currency, Percent: all digits, 1–18.'),
  scale: z.number().int().optional().describe('Digits after the decimal point.'),
  visibleLines: z.number().int().optional(),
  defaultChecked: z.boolean().optional().describe('Checkbox: ticked by default.'),
  values: z
    .array(
      z.union([
        z.string(),
        z.object({
          value: z.string(),
          label: z.string().optional(),
          default: z.boolean().optional(),
        }),
      ])
    )
    .max(1000)
    .optional()
    .describe('Picklist and MultiselectPicklist values, in order.'),
  restricted: z
    .boolean()
    .optional()
    .describe('Picklists: only these values may be saved (default true).'),
  referenceTo: z
    .string()
    .optional()
    .describe('Lookup: the object it points at (Contact, Program__c).'),
  relationshipName: z
    .string()
    .optional()
    .describe('Lookup: the related list’s API name on the parent; default from the label.'),
  relationshipLabel: z
    .string()
    .optional()
    .describe('Lookup: the related list’s label on the parent.'),
  deleteConstraint: z
    .enum(['SetNull', 'Restrict'])
    .optional()
    .describe(
      'Lookup: what happens when the parent is deleted (a required lookup always Restricts).'
    ),
});

function fieldRows(spec: FieldSpec): ComponentView['rows'] {
  const rows: ComponentView['rows'] = [
    { label: 'Label', value: spec.label },
    { label: 'Type', value: spec.type },
  ];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === '' || value === false) return;
    rows.push({ label, value: typeof value === 'string' ? value : JSON.stringify(value) });
  };
  add('Length', spec.length);
  add('Precision', spec.precision);
  add('Scale', spec.scale);
  add('Required', spec.required);
  add('Unique', spec.unique);
  add('External id', spec.externalId);
  add('Track history', spec.trackHistory);
  add(
    'Default',
    spec.type === 'Checkbox' ? (spec.defaultChecked ? 'ticked' : 'unticked') : undefined
  );
  add('Values', spec.values?.map((v) => (v.default ? `${v.value} (default)` : v.value)).join(', '));
  add('Only these values', spec.values ? spec.restricted : undefined);
  add('Points at', spec.referenceTo);
  add(
    'Related list',
    spec.relationshipName ? `${spec.relationshipLabel} (${spec.relationshipName})` : undefined
  );
  add(
    'When the parent is deleted',
    spec.deleteConstraint === 'Restrict'
      ? 'refuse the delete'
      : spec.deleteConstraint
        ? 'clear this field'
        : undefined
  );
  add('Help text', spec.helpText);
  add('Description', spec.description);
  return rows;
}

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
        'or lookup — optionally giving named permission sets access to them. This stores a change ' +
        'request and has Salesforce validate it (a check-only deploy, which changes nothing); the ' +
        'person reviews and applies it from the link this returns. New fields are invisible to ' +
        'people until a permission set grants them, so name the permission sets.',
      // A proposal writes a change request in Renkei, never to Salesforce —
      // but it is a write, so org read-only mode hides it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        fields: z.array(fieldInput).min(1).max(20),
        grantTo: z
          .array(
            z.object({
              permissionSet: z.string().min(1).describe('The permission set’s API name or label.'),
              edit: z.boolean().optional().describe('Edit as well as read (default read only).'),
            })
          )
          .max(10)
          .optional()
          .describe('Permission sets to give access to the new fields once they deploy.'),
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

      const grants: FieldGrant[] = [];
      for (const grant of args.grantTo ?? []) {
        const permissionSet = await resolvePermissionSet(context, access, grant.permissionSet);
        if (typeof permissionSet === 'string') return errText(permissionSet);
        for (const spec of specs) {
          // A required field is visible and editable to everyone already;
          // Salesforce refuses field permissions on one.
          if (spec.required) continue;
          grants.push({
            permissionSetId: permissionSet.id,
            permissionSetName: permissionSet.name,
            object: describe.name,
            field: spec.apiName,
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
      const names = specs.map((spec) => spec.label);
      return proposeAndValidate(context, access, {
        kind: FIELDS_KIND,
        title: `${describe.label}: add ${names.length === 1 ? `the field ${names[0]}` : `${names.length} fields (${names.join(', ')})`}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: { ...built, components, preconditions, fieldGrants: grants },
        summary: [
          ...specs.map(
            (spec) => `• ${describe.name}.${spec.apiName} — ${spec.type}, “${spec.label}”`
          ),
          ...(grants.length > 0
            ? [
                `Then: ${[...new Set(grants.map((g) => `${g.permissionSetName} (${g.edit ? 'read and edit' : 'read'})`))].join(', ')} get access to them.`,
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
          fieldGrants: [],
        },
        summary: [
          `• ${live ? 'Change' : 'New'} rule ${describe.name}.${rule.name}${rule.active ? '' : ' (inactive)'}: blocks a save when ${rule.formula}`,
          `  Message: “${rule.message}”${rule.errorDisplayField ? ` on ${rule.errorDisplayField}` : ''}`,
        ],
      });
    }
  );
}
