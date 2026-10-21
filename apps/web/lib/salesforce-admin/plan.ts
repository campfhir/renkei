/**
 * What a metadata change request holds, and what has to still be true when
 * it is applied.
 *
 * A proposal stores the exact deployment — `files` (the manifest and the
 * object files) and `members` — beside a readable `components` list for
 * the review page, the `preconditions` it was built on, and `fieldGrants`:
 * field access to give named permission sets once the deploy succeeds.
 * Field access is data (FieldPermissions rows), not metadata, because a
 * permission set deployed as metadata replaces itself whole and would drop
 * everything the package did not list.
 *
 * Preconditions are re-read live on apply, and any that no longer holds
 * stops the apply before anything deploys: a field someone else created in
 * the meantime, a validation rule edited since it was read.
 */

import { createHash } from 'node:crypto';
import { soqlString, type PackageMember } from '@renkei/connector-salesforce';
import {
  rec,
  recs,
  sfGet,
  sfQuery,
  str,
  type SalesforceAccess,
  type SalesforceCallContext,
} from '@/lib/mcp-tools/salesforce/client';

export const FIELDS_KIND = 'fields';
export const VALIDATION_RULE_KIND = 'validation_rule';

/** One line of a component on the review page: a value, or old → new. */
export interface ViewRow {
  label: string;
  value: string;
  from?: string;
}

export interface ComponentView {
  /** CustomField, ValidationRule… */
  type: string;
  /** `Object.Member`. */
  name: string;
  action: 'create' | 'update';
  rows: ViewRow[];
}

export type Precondition =
  | { kind: 'field-absent'; object: string; field: string }
  | { kind: 'rule-absent'; object: string; rule: string }
  | { kind: 'rule-unchanged'; object: string; rule: string; fingerprint: string };

export interface FieldGrant {
  permissionSetId: string;
  permissionSetName: string;
  object: string;
  /** With `__c`. */
  field: string;
  edit: boolean;
}

export interface MetadataPayload {
  files: Record<string, string>;
  members: PackageMember[];
  components: ComponentView[];
  preconditions: Precondition[];
  fieldGrants: FieldGrant[];
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rec(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

/** A stored payload, defensively; null when it is not one this code can apply. */
export function readMetadataPayload(value: unknown): MetadataPayload | null {
  const entry = rec(value);
  const files = stringMap(entry.files);
  if (!files['package.xml']) return null;
  const members = recs(entry.members).flatMap((m) =>
    typeof m.type === 'string' && typeof m.member === 'string'
      ? [{ type: m.type, member: m.member }]
      : []
  );
  const components = recs(entry.components).map((c) => ({
    type: str(c.type),
    name: str(c.name),
    action: c.action === 'update' ? ('update' as const) : ('create' as const),
    rows: recs(c.rows).map((row) => ({
      label: str(row.label),
      value: str(row.value),
      ...(typeof row.from === 'string' ? { from: row.from } : {}),
    })),
  }));
  const preconditions = recs(entry.preconditions).flatMap((p): Precondition[] => {
    const object = str(p.object);
    if (p.kind === 'field-absent') return [{ kind: 'field-absent', object, field: str(p.field) }];
    if (p.kind === 'rule-absent') return [{ kind: 'rule-absent', object, rule: str(p.rule) }];
    if (p.kind === 'rule-unchanged') {
      return [
        { kind: 'rule-unchanged', object, rule: str(p.rule), fingerprint: str(p.fingerprint) },
      ];
    }
    return [];
  });
  const fieldGrants = recs(entry.fieldGrants).map((g) => ({
    permissionSetId: str(g.permissionSetId),
    permissionSetName: str(g.permissionSetName),
    object: str(g.object),
    field: str(g.field),
    edit: g.edit === true,
  }));
  return { files, members, components, preconditions, fieldGrants };
}

/** A Tooling API query (`/tooling/query`), one page. */
export async function toolingQuery(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  soql: string
): Promise<{ ok: true; records: Record<string, unknown>[] } | { ok: false; error: string }> {
  const result = await sfGet(context, access, `/tooling/query?q=${encodeURIComponent(soql)}`);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, records: recs(rec(result.body).records) };
}

/** Whether a field exists on an object, whoever can see it (FieldDefinition, not the describe). */
export async function fieldExists(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  field: string
): Promise<boolean | string> {
  const found = await sfQuery(
    context,
    access,
    `SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ${soqlString(object)} AND QualifiedApiName = ${soqlString(field)}`
  );
  if (!found.ok) return found.error;
  return found.records.length > 0;
}

export interface LiveRule {
  id: string;
  name: string;
  active: boolean;
  description: string;
  formula: string;
  message: string;
  errorDisplayField: string;
  /** A hash of the rule's metadata as read, to tell whether it moved since. */
  fingerprint: string;
}

/** One validation rule with its formula, from the Tooling API (Metadata needs a one-row query). */
export async function readValidationRule(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string,
  rule: string
): Promise<LiveRule | null | string> {
  const found = await toolingQuery(
    context,
    access,
    `SELECT Id, ValidationName, Active, Description, ErrorMessage, ErrorDisplayField, Metadata FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = ${soqlString(object)} AND ValidationName = ${soqlString(rule)} LIMIT 1`
  );
  if (!found.ok) return found.error;
  const row = found.records[0];
  if (!row) return null;
  const metadata = rec(row.Metadata);
  return {
    id: str(row.Id),
    name: str(row.ValidationName),
    active: row.Active === true,
    description: str(row.Description),
    formula: str(metadata.errorConditionFormula),
    message: str(row.ErrorMessage) || str(metadata.errorMessage),
    errorDisplayField: str(row.ErrorDisplayField) || str(metadata.errorDisplayField),
    fingerprint: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
  };
}

/** The preconditions that no longer hold, in words; empty when the package may deploy. */
export async function brokenPreconditions(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  preconditions: readonly Precondition[]
): Promise<string[]> {
  const broken: string[] = [];
  for (const precondition of preconditions) {
    if (precondition.kind === 'field-absent') {
      const exists = await fieldExists(context, access, precondition.object, precondition.field);
      if (typeof exists === 'string')
        broken.push(`Could not check ${precondition.object}.${precondition.field}: ${exists}`);
      else if (exists) {
        broken.push(
          `${precondition.object}.${precondition.field} exists now — someone created it since this was proposed.`
        );
      }
    } else {
      const live = await readValidationRule(
        context,
        access,
        precondition.object,
        precondition.rule
      );
      const name = `${precondition.object}.${precondition.rule}`;
      if (typeof live === 'string') broken.push(`Could not check the rule ${name}: ${live}`);
      else if (precondition.kind === 'rule-absent' && live) {
        broken.push(`The rule ${name} exists now — someone created it since this was proposed.`);
      } else if (precondition.kind === 'rule-unchanged') {
        if (!live)
          broken.push(`The rule ${name} is gone — someone deleted it since this was proposed.`);
        else if (live.fingerprint !== precondition.fingerprint) {
          broken.push(
            `The rule ${name} was changed since this was proposed; propose again from what it is now.`
          );
        }
      }
    }
  }
  return broken;
}

/** A permission set by API name or label, for field grants. */
export async function resolvePermissionSet(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  ref: string
): Promise<{ id: string; name: string } | string> {
  const literal = soqlString(ref.trim());
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND (Name = ${literal} OR Label = ${literal}) LIMIT 3`
  );
  if (!found.ok) return found.error;
  if (found.records.length === 1) {
    return { id: str(found.records[0].Id), name: str(found.records[0].Name) };
  }
  if (found.records.length > 1) {
    return `"${ref}" names more than one permission set: ${found.records.map((r) => str(r.Name)).join(', ')}. Use the API name.`;
  }
  return `No permission set "${ref}" in this org (profiles are not offered — grant access through permission sets).`;
}
