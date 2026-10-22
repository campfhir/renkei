/**
 * What the salesforce_admin_ proposals share: storing a change request,
 * having Salesforce validate it with a check-only deploy (or, for a change
 * that is data only, recording the proposal's own checks), and answering
 * with the outcome and the review link; the refusal for an org that takes
 * no changes; and the field input every proposal that creates fields takes.
 */

import { z } from 'zod';
import type { Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import { FIELD_TYPES, takesChanges, type FieldSpec } from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import { errText, type SalesforceAccess } from '../salesforce/client';
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
import { deploys, type ComponentView, type MetadataPayload } from '@/lib/salesforce-admin/plan';
import { reviewPrefix } from './review-link';

/** How long a proposal waits on Salesforce's validation before answering. */
export const VALIDATION_WAIT_MS = 60_000;

export const reasonField = z
  .string()
  .max(2000)
  .optional()
  .describe('Why, in the person’s words — shown on the review page.');

export const replacesField = z
  .string()
  .optional()
  .describe('The id of an earlier pending request this one replaces; that one is cancelled.');

export function dbOf(context: MCPToolContext): Kysely<DB> | null {
  if (context.db) return context.db;
  const result = getDatabase();
  return result.ok ? result.val : null;
}

/** Why this org takes no proposals, or null. */
export async function refusesChanges(access: SalesforceAccess): Promise<string | null> {
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
    return validation.deployId
      ? ['Salesforce validated it: a check-only deploy passed and changed nothing.']
      : ['Nothing to deploy: every step was checked against the org as it is now.'];
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
export async function proposeAndValidate(
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
  const started = deploys(input.payload)
    ? await startDeploy(context, access, input.payload.files, { checkOnly: true })
    : null;
  if (!started) {
    // Data only: nothing for Salesforce to dry-run; the proposal's own
    // checks (every name resolved, every id read back) are the validation.
    validation = {
      deployId: '',
      done: true,
      success: true,
      status: 'Checked',
      failures: [],
      checkedAt: new Date().toISOString(),
    };
  } else if (!started.ok) {
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

export const fieldInput = z.object({
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

export function fieldRows(spec: FieldSpec): ComponentView['rows'] {
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
