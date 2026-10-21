/**
 * Metadata for the admin connector's change requests: what a proposal may
 * build, checked before anything reaches Salesforce, and the exact files a
 * deploy sends (docs/salesforce-connectors-design.md, "Writes go through the
 * Metadata API, as deploys").
 *
 * Pure. A proposal is checked here (names, types and the options each type
 * takes), turned into Metadata API XML in the classic source format — an
 * `objects/<Object>.object` file carrying only the fields and rules being
 * deployed, and a `package.xml` naming exactly those members, so nothing
 * else on the object is touched — and the check-only deploy then lets
 * Salesforce check everything this cannot (formulas, references, limits).
 * Deploy results come back through `parseDeployResult`.
 */

import { SALESFORCE_API_VERSION } from './api';
import { isSoqlIdentifier } from './soql';

export const METADATA_NAMESPACE = 'http://soap.sforce.com/2006/04/metadata';

/** The field types a proposal may create. */
export const FIELD_TYPES = [
  'Text',
  'TextArea',
  'LongTextArea',
  'Number',
  'Currency',
  'Percent',
  'Date',
  'DateTime',
  'Checkbox',
  'Email',
  'Phone',
  'Url',
  'Picklist',
  'MultiselectPicklist',
  'Lookup',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface PicklistValueSpec {
  value: string;
  label: string;
  default: boolean;
}

/** One new custom field, checked and complete: every option the XML needs is settled. */
export interface FieldSpec {
  object: string;
  /** With the `__c` suffix. */
  apiName: string;
  label: string;
  type: FieldType;
  description?: string;
  helpText?: string;
  required: boolean;
  unique: boolean;
  externalId: boolean;
  trackHistory: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  visibleLines?: number;
  /** Checkbox only. */
  defaultChecked?: boolean;
  values?: PicklistValueSpec[];
  /** Picklists: only the listed values may be saved. */
  restricted?: boolean;
  referenceTo?: string;
  relationshipName?: string;
  relationshipLabel?: string;
  deleteConstraint?: 'SetNull' | 'Restrict';
}

export interface ValidationRuleSpec {
  object: string;
  /** The rule's developer name (no namespace). */
  name: string;
  active: boolean;
  description?: string;
  formula: string;
  message: string;
  /** The field the message shows on; the top of the page when absent. */
  errorDisplayField?: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

/**
 * Whether `name` is a developer name Salesforce accepts: a letter first,
 * then letters, digits and single underscores, not ending in one, at most
 * `max` characters.
 */
export function isDeveloperName(name: string, max = 40): boolean {
  return (
    name.length > 0 &&
    name.length <= max &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(name) &&
    !name.includes('__') &&
    !name.endsWith('_')
  );
}

/**
 * The developer name Setup would suggest for a label: words joined by
 * underscores, anything else dropped — "Visit Date (planned)" gives
 * Visit_Date_planned. Empty when the label has no letters to start with.
 */
export function developerNameOf(label: string, max = 40): string {
  let name = '';
  let gap = false;
  for (const ch of label) {
    if (/[A-Za-z0-9]/.test(ch)) {
      if (!name && !/[A-Za-z]/.test(ch)) continue;
      const next = gap && name ? `_${ch}` : ch;
      if (name.length + next.length > max) break;
      name += next;
      gap = false;
    } else {
      gap = true;
    }
  }
  return name;
}

const TEXT_LENGTH = { min: 1, max: 255, fallback: 255 };
const LONG_TEXT_LENGTH = { min: 256, max: 131_072, fallback: 32_768 };

/**
 * A proposed field, checked: the API name (derived from the label when not
 * given), the options its type takes and no others, and no clash with the
 * object's existing fields. Errors are sentences the model can act on.
 */
export function checkFieldSpec(
  input: unknown,
  existingFields: readonly string[]
): Checked<FieldSpec> {
  const entry = record(input);
  const errors: string[] = [];
  const object = str(entry.object);
  if (!isSoqlIdentifier(object) || object.includes('.')) {
    errors.push(`"${object}" is not an object API name.`);
  }
  const label = str(entry.label);
  if (!label) errors.push('Each field needs a label.');
  if (label.length > 40)
    errors.push(`"${label}" is over 40 characters; a field label is 40 at most.`);
  const type = str(entry.type);
  const fieldType = FIELD_TYPES.find((candidate) => candidate === type);
  if (!fieldType) {
    errors.push(`"${type}" is not a field type this can create. Types: ${FIELD_TYPES.join(', ')}.`);
  }
  const given = str(entry.apiName).replace(/__c$/i, '');
  const base = given || developerNameOf(label);
  if (!isDeveloperName(base)) {
    errors.push(
      `"${given || label}" does not make a field API name: a letter first, then letters, digits and single underscores, 40 at most, not ending in an underscore.`
    );
  }
  const apiName = `${base}__c`;
  if (existingFields.some((name) => name.toLowerCase() === apiName.toLowerCase())) {
    errors.push(`${object} already has a field ${apiName}.`);
  }
  if (!fieldType) return { ok: false, errors };

  const required = entry.required === true;
  const unique = entry.unique === true;
  const externalId = entry.externalId === true;
  const spec: FieldSpec = {
    object,
    apiName,
    label,
    type: fieldType,
    ...(str(entry.description) ? { description: str(entry.description) } : {}),
    ...(str(entry.helpText) ? { helpText: str(entry.helpText) } : {}),
    required,
    unique,
    externalId,
    trackHistory: entry.trackHistory === true,
  };
  if (spec.helpText && spec.helpText.length > 510)
    errors.push('Help text is 510 characters at most.');
  if (spec.description && spec.description.length > 1000) {
    errors.push('A description is 1,000 characters at most.');
  }
  if ((unique || externalId) && !['Text', 'Number', 'Email'].includes(fieldType)) {
    errors.push('Only text, number and email fields can be unique or an external id.');
  }
  if (required && ['Checkbox', 'MultiselectPicklist', 'LongTextArea'].includes(fieldType)) {
    errors.push(`A ${fieldType} field cannot be required.`);
  }

  const length = int(entry.length);
  switch (fieldType) {
    case 'Text': {
      spec.length = length ?? TEXT_LENGTH.fallback;
      if (spec.length < TEXT_LENGTH.min || spec.length > TEXT_LENGTH.max) {
        errors.push('A text field’s length is 1 to 255; use LongTextArea for more.');
      }
      break;
    }
    case 'LongTextArea': {
      spec.length = length ?? LONG_TEXT_LENGTH.fallback;
      spec.visibleLines = int(entry.visibleLines) ?? 5;
      if (spec.length < LONG_TEXT_LENGTH.min || spec.length > LONG_TEXT_LENGTH.max) {
        errors.push('A long text area’s length is 256 to 131,072.');
      }
      if (spec.visibleLines < 2 || spec.visibleLines > 50) {
        errors.push('A long text area shows 2 to 50 lines.');
      }
      break;
    }
    case 'Number':
    case 'Currency':
    case 'Percent': {
      spec.precision = int(entry.precision) ?? 18;
      spec.scale = int(entry.scale) ?? (fieldType === 'Number' ? 0 : 2);
      if (spec.precision < 1 || spec.precision > 18) {
        errors.push('Precision (all digits) is 1 to 18.');
      }
      if (spec.scale < 0 || spec.scale > spec.precision) {
        errors.push('Scale (digits after the point) is 0 up to the precision.');
      }
      break;
    }
    case 'Checkbox':
      spec.defaultChecked = entry.defaultChecked === true;
      break;
    case 'Picklist':
    case 'MultiselectPicklist': {
      const values = Array.isArray(entry.values) ? entry.values : [];
      const seen = new Set<string>();
      spec.values = [];
      for (const raw of values) {
        const item = typeof raw === 'string' ? { value: raw } : record(raw);
        const value = str(item.value);
        if (!value) continue;
        if (value.length > 255)
          errors.push(`Picklist value "${value.slice(0, 40)}…" is over 255 characters.`);
        if (seen.has(value.toLowerCase()))
          errors.push(`Picklist value "${value}" is listed twice.`);
        seen.add(value.toLowerCase());
        spec.values.push({
          value,
          label: str(item.label) || value,
          default: item.default === true,
        });
      }
      if (spec.values.length === 0) errors.push('A picklist needs at least one value.');
      if (spec.values.length > 1000) errors.push('A picklist has 1,000 values at most.');
      if (fieldType === 'Picklist' && spec.values.filter((v) => v.default).length > 1) {
        errors.push('A picklist has one default value at most.');
      }
      spec.restricted = entry.restricted !== false;
      if (fieldType === 'MultiselectPicklist') spec.visibleLines = int(entry.visibleLines) ?? 4;
      break;
    }
    case 'Lookup': {
      const target = str(entry.referenceTo);
      if (!isSoqlIdentifier(target) || target.includes('.')) {
        errors.push('A lookup needs referenceTo: the API name of the object it points at.');
      }
      spec.referenceTo = target;
      const relationship = str(entry.relationshipName) || developerNameOf(label);
      if (!isDeveloperName(relationship)) {
        errors.push(`"${relationship}" is not a relationship name.`);
      }
      spec.relationshipName = relationship;
      spec.relationshipLabel = str(entry.relationshipLabel) || label;
      // A required lookup cannot be cleared when its parent goes, so it must
      // refuse the parent's delete instead.
      spec.deleteConstraint =
        required || entry.deleteConstraint === 'Restrict' ? 'Restrict' : 'SetNull';
      break;
    }
    default:
      break;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: spec };
}

/** A proposed validation rule, checked as far as Renkei can; Salesforce checks the formula. */
export function checkValidationRuleSpec(input: unknown): Checked<ValidationRuleSpec> {
  const entry = record(input);
  const errors: string[] = [];
  const object = str(entry.object);
  if (!isSoqlIdentifier(object) || object.includes('.')) {
    errors.push(`"${object}" is not an object API name.`);
  }
  const name = str(entry.name) || developerNameOf(str(entry.label));
  if (!isDeveloperName(name)) {
    errors.push(
      `"${name}" is not a rule name: a letter first, then letters, digits and single underscores, 40 at most.`
    );
  }
  const formula = typeof entry.formula === 'string' ? entry.formula.trim() : '';
  if (!formula) errors.push('A validation rule needs its formula — true when the record is wrong.');
  if (formula.length > 5000)
    errors.push('A validation rule’s formula is 5,000 characters at most.');
  const message = str(entry.message);
  if (!message)
    errors.push('A validation rule needs the message people see when it blocks a save.');
  if (message.length > 255) errors.push('The error message is 255 characters at most.');
  const errorDisplayField = str(entry.errorDisplayField);
  if (
    errorDisplayField &&
    (!isSoqlIdentifier(errorDisplayField) || errorDisplayField.includes('.'))
  ) {
    errors.push(`"${errorDisplayField}" is not a field API name.`);
  }
  const description = str(entry.description);
  if (description.length > 1000) errors.push('A description is 1,000 characters at most.');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      object,
      name,
      active: entry.active !== false,
      ...(description ? { description } : {}),
      formula,
      message,
      ...(errorDisplayField ? { errorDisplayField } : {}),
    },
  };
}

/** Text for an XML element's content or an attribute. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function element(
  name: string,
  value: string | number | boolean | undefined,
  indent: string
): string {
  if (value === undefined) return '';
  return `${indent}<${name}>${xmlEscape(String(value))}</${name}>\n`;
}

/** The `<fields>` element of one new field. */
export function fieldXml(spec: FieldSpec): string {
  const i = '        ';
  let body = '';
  body += element('fullName', spec.apiName, i);
  body += element('label', spec.label, i);
  body += element('description', spec.description, i);
  body += element('inlineHelpText', spec.helpText, i);
  body += element('trackHistory', spec.trackHistory, i);
  body += element('externalId', spec.externalId || undefined, i);
  switch (spec.type) {
    case 'Text':
      body += element('length', spec.length, i);
      body += element('required', spec.required, i);
      body += element('unique', spec.unique, i);
      break;
    case 'TextArea':
    case 'Date':
    case 'DateTime':
    case 'Phone':
    case 'Url':
      body += element('required', spec.required, i);
      break;
    case 'Email':
      body += element('required', spec.required, i);
      body += element('unique', spec.unique, i);
      break;
    case 'LongTextArea':
      body += element('length', spec.length, i);
      body += element('visibleLines', spec.visibleLines, i);
      break;
    case 'Number':
    case 'Currency':
    case 'Percent':
      body += element('precision', spec.precision, i);
      body += element('scale', spec.scale, i);
      body += element('required', spec.required, i);
      if (spec.type === 'Number') body += element('unique', spec.unique, i);
      break;
    case 'Checkbox':
      body += element('defaultValue', spec.defaultChecked ?? false, i);
      break;
    case 'Picklist':
    case 'MultiselectPicklist': {
      if (spec.type === 'Picklist') body += element('required', spec.required, i);
      if (spec.type === 'MultiselectPicklist')
        body += element('visibleLines', spec.visibleLines, i);
      const values = (spec.values ?? [])
        .map(
          (v) =>
            `${i}        <value>\n${element('fullName', v.value, `${i}            `)}${element('default', v.default, `${i}            `)}${element('label', v.label, `${i}            `)}${i}        </value>\n`
        )
        .join('');
      body +=
        `${i}<valueSet>\n` +
        element('restricted', spec.restricted ?? true, `${i}    `) +
        `${i}    <valueSetDefinition>\n` +
        element('sorted', false, `${i}        `) +
        values +
        `${i}    </valueSetDefinition>\n` +
        `${i}</valueSet>\n`;
      break;
    }
    case 'Lookup':
      body += element('referenceTo', spec.referenceTo, i);
      body += element('relationshipName', spec.relationshipName, i);
      body += element('relationshipLabel', spec.relationshipLabel, i);
      body += element('deleteConstraint', spec.deleteConstraint, i);
      body += element('required', spec.required, i);
      break;
    default:
      break;
  }
  body += element('type', spec.type, i);
  return `    <fields>\n${body}    </fields>\n`;
}

/** The `<validationRules>` element of one rule. */
export function validationRuleXml(spec: ValidationRuleSpec): string {
  const i = '        ';
  return (
    `    <validationRules>\n` +
    element('fullName', spec.name, i) +
    element('active', spec.active, i) +
    element('description', spec.description, i) +
    element('errorConditionFormula', spec.formula, i) +
    element('errorDisplayField', spec.errorDisplayField, i) +
    element('errorMessage', spec.message, i) +
    `    </validationRules>\n`
  );
}

export interface PackageMember {
  /** A Metadata API type: CustomField, ValidationRule… */
  type: string;
  /** `Object.Member` for children of an object. */
  member: string;
}

/** The manifest naming exactly these members. */
export function packageXml(members: readonly PackageMember[]): string {
  const byType = new Map<string, string[]>();
  for (const { type, member } of members) {
    byType.set(type, [...(byType.get(type) ?? []), member]);
  }
  const types = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([type, names]) =>
        `    <types>\n${[...new Set(names)]
          .sort((a, b) => a.localeCompare(b))
          .map((name) => `        <members>${xmlEscape(name)}</members>\n`)
          .join('')}        <name>${xmlEscape(type)}</name>\n    </types>\n`
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="${METADATA_NAMESPACE}">\n` +
    `${types}    <version>${SALESFORCE_API_VERSION}</version>\n</Package>\n`
  );
}

/** One object's file, carrying only the given child elements. */
export function objectFileXml(children: readonly string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="${METADATA_NAMESPACE}">\n` +
    `${children.join('')}</CustomObject>\n`
  );
}

/**
 * The files of a deployment of new fields and validation rules: a
 * `package.xml` naming each, and one `objects/<Object>.object` per object
 * holding only them, so nothing else on the object is deployed.
 */
export function buildObjectChildrenPackage(input: {
  fields?: readonly FieldSpec[];
  rules?: readonly ValidationRuleSpec[];
}): { files: Record<string, string>; members: PackageMember[] } {
  const members: PackageMember[] = [];
  const children = new Map<string, string[]>();
  const add = (object: string, xml: string) =>
    children.set(object, [...(children.get(object) ?? []), xml]);
  for (const field of input.fields ?? []) {
    members.push({ type: 'CustomField', member: `${field.object}.${field.apiName}` });
    add(field.object, fieldXml(field));
  }
  for (const rule of input.rules ?? []) {
    members.push({ type: 'ValidationRule', member: `${rule.object}.${rule.name}` });
    add(rule.object, validationRuleXml(rule));
  }
  const files: Record<string, string> = { 'package.xml': packageXml(members) };
  for (const [object, xml] of children) files[`objects/${object}.object`] = objectFileXml(xml);
  return { files, members };
}

export interface DeployFailure {
  type: string;
  name: string;
  problem: string;
  line?: number;
}

export interface DeployOutcome {
  id: string;
  done: boolean;
  /** Pending, InProgress, Succeeded, Failed, Canceled… */
  status: string;
  success: boolean;
  checkOnly: boolean;
  componentsDeployed: number;
  componentsTotal: number;
  failures: DeployFailure[];
  /** Salesforce's own message when the deploy as a whole failed. */
  errorMessage?: string;
}

const num = (value: unknown): number =>
  typeof value === 'number' ? value : typeof value === 'string' && value ? Number(value) || 0 : 0;
const flag = (value: unknown): boolean => value === true || value === 'true';

/** A deployRequest answer (create or status), defensively: REST sends some booleans as strings. */
export function parseDeployResult(body: unknown): DeployOutcome {
  const outer = record(body);
  const result = record(outer.deployResult);
  const details = record(result.details);
  const failuresRaw = Array.isArray(details.componentFailures)
    ? details.componentFailures
    : details.componentFailures
      ? [details.componentFailures]
      : [];
  const failures = failuresRaw.map((raw) => {
    const failure = record(raw);
    const line = num(failure.lineNumber);
    return {
      type: str(failure.componentType),
      name: str(failure.fullName),
      problem: str(failure.problem),
      ...(line ? { line } : {}),
    };
  });
  const errorMessage = str(result.errorMessage);
  return {
    id: str(result.id) || str(outer.id),
    done: flag(result.done),
    status: str(result.status),
    success: flag(result.success),
    checkOnly: flag(result.checkOnly),
    componentsDeployed: num(result.numberComponentsDeployed),
    componentsTotal: num(result.numberComponentsTotal),
    failures,
    ...(errorMessage ? { errorMessage } : {}),
  };
}
