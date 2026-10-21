/**
 * Changes to what already exists, and new custom objects — the proposals
 * that read a live definition and send it back whole (an existing field
 * deploys as its whole definition), or build a new object with its first
 * fields and tab. Each check refuses what would lose data or that this
 * version cannot make safely, in words the model can act on. Pure.
 */

import {
  checkFieldSpec,
  developerNameOf,
  fieldXml,
  isDeveloperName,
  objectFileXml,
  packageXml,
  xmlEscape,
  type FieldSpec,
  type PackageMember,
} from './metadata';
import { metadataBody, metadataFile } from './metadata-xml';
import { mergeValueList, type PicklistChanges } from './picklists';

export type { PicklistChanges } from './picklists';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** One line of a change for the review page: what it is now, and what it becomes. */
export interface ChangeRow {
  label: string;
  value: string;
  from?: string;
}

const show = (value: unknown): string =>
  value === null || value === undefined || value === '' ? '(none)' : String(value);

export interface FieldChanges {
  label?: string;
  helpText?: string;
  description?: string;
  required?: boolean;
  length?: number;
  visibleLines?: number;
  precision?: number;
  scale?: number;
  /** A formula or literal, as Salesforce takes it (`'Open'`, `TODAY()`, `true`). */
  defaultValue?: string;
}

const TYPES_WITH_LENGTH = new Set(['Text', 'LongTextArea', 'Html', 'EncryptedText']);
const TYPES_WITH_PRECISION = new Set(['Number', 'Currency', 'Percent']);

/**
 * An existing custom field's metadata with the changes merged in, and its
 * rows old → new — or why not. Shrinking a length or a number's digits
 * would cut existing values, and changing a type is not something this
 * does, so both are refused.
 */
export function mergeFieldChanges(
  metadata: Json,
  changes: FieldChanges & { type?: string }
): { ok: true; metadata: Json; rows: ChangeRow[] } | { ok: false; errors: string[] } {
  const next = structuredClone(metadata);
  const errors: string[] = [];
  const rows: ChangeRow[] = [];
  const type = str(metadata.type);
  const set = (key: string, label: string, value: unknown) => {
    if (value === undefined) return;
    if (String(next[key] ?? '') === String(value)) return;
    rows.push({ label, value: show(value), from: show(next[key]) });
    next[key] = value;
  };

  if (changes.type && changes.type !== type) {
    errors.push(
      `Changing a field’s type (${type} to ${changes.type}) can lose data and is not offered; change it in Setup, where Salesforce shows what would be lost.`
    );
  }
  if (changes.label !== undefined) {
    if (!changes.label.trim() || changes.label.length > 40)
      errors.push('A field label is 1 to 40 characters.');
    set('label', 'Label', changes.label.trim());
  }
  if (changes.helpText !== undefined) {
    if (changes.helpText.length > 510) errors.push('Help text is 510 characters at most.');
    set('inlineHelpText', 'Help text', changes.helpText.trim() || null);
  }
  if (changes.description !== undefined) {
    if (changes.description.length > 1000)
      errors.push('A description is 1,000 characters at most.');
    set('description', 'Description', changes.description.trim() || null);
  }
  if (changes.required !== undefined) {
    if (['Checkbox', 'LongTextArea', 'MultiselectPicklist', 'Html'].includes(type)) {
      errors.push(`A ${type} field cannot be required.`);
    } else if (metadata.formula || type === 'Summary' || type === 'AutoNumber') {
      errors.push('A calculated field cannot be required.');
    } else {
      set('required', 'Required', changes.required);
    }
  }
  if (changes.length !== undefined) {
    if (!TYPES_WITH_LENGTH.has(type)) errors.push(`A ${type} field has no length to change.`);
    else {
      const current = Number(metadata.length ?? 0);
      if (changes.length < current) {
        errors.push(
          `Shortening ${type} from ${current} to ${changes.length} would cut existing values; it is not offered.`
        );
      } else if (type === 'Text' && changes.length > 255) {
        errors.push('A text field is 255 characters at most.');
      } else if (type !== 'Text' && changes.length > 131_072) {
        errors.push('A long text area is 131,072 characters at most.');
      } else set('length', 'Length', changes.length);
    }
  }
  if (changes.visibleLines !== undefined)
    set('visibleLines', 'Visible lines', changes.visibleLines);
  if (changes.precision !== undefined || changes.scale !== undefined) {
    if (!TYPES_WITH_PRECISION.has(type)) errors.push(`A ${type} field has no digits to change.`);
    else {
      const precision = changes.precision ?? Number(metadata.precision ?? 18);
      const scale = changes.scale ?? Number(metadata.scale ?? 0);
      const integerDigits = precision - scale;
      const currentInteger = Number(metadata.precision ?? 18) - Number(metadata.scale ?? 0);
      if (precision > 18 || scale < 0 || scale > precision) {
        errors.push('Precision is 1 to 18 digits, and scale 0 up to the precision.');
      } else if (integerDigits < currentInteger || scale < Number(metadata.scale ?? 0)) {
        errors.push('Fewer digits would cut or round existing values; it is not offered.');
      } else {
        set('precision', 'Precision', precision);
        set('scale', 'Scale', scale);
      }
    }
  }
  if (changes.defaultValue !== undefined) {
    if (type === 'Checkbox' && !['true', 'false'].includes(changes.defaultValue.trim())) {
      errors.push('A checkbox’s default is true or false.');
    } else set('defaultValue', 'Default', changes.defaultValue.trim() || null);
  }
  if (errors.length === 0 && rows.length === 0) errors.push('Nothing in that changes the field.');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, metadata: next, rows };
}

/**
 * A picklist field's metadata with value changes merged in, and its rows —
 * or why not. A picklist on a global value set changes there, not here
 * (picklists.ts mergeGlobalValueSetChanges).
 * Values are never deleted: deactivating keeps them on the records that
 * hold them, the way Setup does.
 */
export function mergePicklistChanges(
  metadata: Json,
  changes: PicklistChanges
): { ok: true; metadata: Json; rows: ChangeRow[] } | { ok: false; errors: string[] } {
  const next = structuredClone(metadata);
  const errors: string[] = [];
  const rows: ChangeRow[] = [];
  const valueSet = isRecord(next.valueSet) ? next.valueSet : null;
  if (!['Picklist', 'MultiselectPicklist'].includes(str(metadata.type)) || !valueSet) {
    return { ok: false, errors: ['That field is not a picklist.'] };
  }
  if (str(valueSet.valueSetName)) {
    return {
      ok: false,
      errors: [
        `This picklist uses the global value set ${str(valueSet.valueSetName)}; its values change there, for every field that uses it.`,
      ],
    };
  }
  const definition = isRecord(valueSet.valueSetDefinition)
    ? valueSet.valueSetDefinition
    : { value: [] };
  valueSet.valueSetDefinition = definition;
  const values: Json[] = Array.isArray(definition.value) ? definition.value.filter(isRecord) : [];
  definition.value = values;
  const merged = mergeValueList(values, changes, (add) => ({
    fullName: add.value,
    default: false,
    label: add.label?.trim() || add.value,
  }));
  errors.push(...merged.errors);
  rows.push(...merged.rows);
  if (errors.length === 0 && rows.length === 0)
    errors.push('Nothing in that changes the picklist.');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, metadata: next, rows };
}

/** A whole existing field as a deployable `<fields>` element. */
export function existingFieldXml(fullName: string, metadata: Json): string {
  return `    <fields>\n        <fullName>${xmlEscape(fullName)}</fullName>\n${metadataBody(metadata, '        ')}    </fields>\n`;
}

export const SHARING_MODELS = ['ReadWrite', 'Read', 'Private'] as const;
export type SharingModel = (typeof SHARING_MODELS)[number];

export interface ObjectSpec {
  /** With `__c`. */
  apiName: string;
  label: string;
  pluralLabel: string;
  description?: string;
  nameField:
    | { type: 'Text'; label: string }
    | { type: 'AutoNumber'; label: string; displayFormat: string; startingNumber: number };
  sharingModel: SharingModel;
  activities: boolean;
  history: boolean;
  reports: boolean;
  search: boolean;
  /** The tab's icon (a Salesforce `motif` such as `Custom18: Form`). */
  tabMotif: string;
  fields: FieldSpec[];
}

/** A proposed custom object, checked: names, the name field, sharing, and its first fields. */
export function checkObjectSpec(
  input: unknown,
  existingObjects: readonly string[]
): { ok: true; value: ObjectSpec } | { ok: false; errors: string[] } {
  const entry = isRecord(input) ? input : {};
  const errors: string[] = [];
  const label = str(entry.label);
  if (!label || label.length > 40) errors.push('An object label is 1 to 40 characters.');
  const pluralLabel = str(entry.pluralLabel) || (label ? `${label}s` : '');
  if (pluralLabel.length > 40) errors.push('A plural label is 40 characters at most.');
  const base = str(entry.apiName).replace(/__c$/i, '') || developerNameOf(label);
  if (!isDeveloperName(base)) {
    errors.push(
      `"${base || label}" does not make an object API name: a letter first, then letters, digits and single underscores, 40 at most.`
    );
  }
  const apiName = `${base}__c`;
  if (existingObjects.some((name) => name.toLowerCase() === apiName.toLowerCase())) {
    errors.push(`There is already an object ${apiName}.`);
  }
  const name = isRecord(entry.nameField) ? entry.nameField : {};
  const nameLabel = str(name.label) || `${label} Name`;
  let nameField: ObjectSpec['nameField'];
  if (name.type === 'AutoNumber') {
    const displayFormat = str(name.displayFormat) || `${base.slice(0, 3).toUpperCase()}-{0000}`;
    if (!/\{0+\}/.test(displayFormat))
      errors.push('An auto-number’s format needs a number part, like V-{0000}.');
    const startingNumber = typeof name.startingNumber === 'number' ? name.startingNumber : 1;
    nameField = { type: 'AutoNumber', label: nameLabel, displayFormat, startingNumber };
  } else {
    nameField = { type: 'Text', label: nameLabel };
  }
  const sharing = str(entry.sharingModel) || 'ReadWrite';
  const sharingModel = SHARING_MODELS.find((model) => model === sharing);
  if (!sharingModel) {
    errors.push(
      `Sharing is one of ${SHARING_MODELS.join(', ')} (Controlled by Parent needs a master-detail field, which this does not create).`
    );
  }
  const fields: FieldSpec[] = [];
  for (const raw of Array.isArray(entry.fields) ? entry.fields : []) {
    const checked = checkFieldSpec(
      { ...(isRecord(raw) ? raw : {}), object: apiName },
      fields.map((f) => f.apiName)
    );
    if (checked.ok) fields.push(checked.value);
    else
      errors.push(
        ...checked.errors.map((error) => `${str(isRecord(raw) ? raw.label : '')}: ${error}`)
      );
  }
  if (fields.length > 50)
    errors.push('At most 50 first fields; add more with salesforce_admin_propose_fields.');
  const description = str(entry.description);
  if (description.length > 1000) errors.push('A description is 1,000 characters at most.');
  if (errors.length > 0 || !sharingModel) return { ok: false, errors };
  return {
    ok: true,
    value: {
      apiName,
      label,
      pluralLabel,
      ...(description ? { description } : {}),
      nameField,
      sharingModel,
      activities: entry.activities !== false,
      history: entry.history === true,
      reports: entry.reports !== false,
      search: entry.search !== false,
      tabMotif: str(entry.tabMotif) || 'Custom18: Form',
      fields,
    },
  };
}

/**
 * The files of a new object: the object with its name field, features and
 * first fields, and a tab for it.
 */
export function buildObjectPackage(spec: ObjectSpec): {
  files: Record<string, string>;
  members: PackageMember[];
} {
  const nameField: Json =
    spec.nameField.type === 'AutoNumber'
      ? {
          displayFormat: spec.nameField.displayFormat,
          label: spec.nameField.label,
          startingNumber: spec.nameField.startingNumber,
          type: 'AutoNumber',
        }
      : { label: spec.nameField.label, type: 'Text' };
  const head = metadataBody({
    allowInChatterGroups: false,
    deploymentStatus: 'Deployed',
    description: spec.description ?? null,
    enableActivities: spec.activities,
    enableBulkApi: true,
    enableHistory: spec.history,
    enableReports: spec.reports,
    enableSearch: spec.search,
    enableSharing: true,
    enableStreamingApi: true,
    label: spec.label,
    nameField,
    pluralLabel: spec.pluralLabel,
    sharingModel: spec.sharingModel,
  });
  const members: PackageMember[] = [
    { type: 'CustomObject', member: spec.apiName },
    { type: 'CustomTab', member: spec.apiName },
  ];
  return {
    files: {
      'package.xml': packageXml(members),
      [`objects/${spec.apiName}.object`]: objectFileXml([head, ...spec.fields.map(fieldXml)]),
      [`tabs/${spec.apiName}.tab`]: metadataFile('CustomTab', {
        customObject: true,
        motif: spec.tabMotif,
      }),
    },
    members,
  };
}
