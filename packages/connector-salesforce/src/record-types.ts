/**
 * Record types: a new one checked and written as the object's
 * `<recordTypes>` child, an existing object child written back whole
 * (a record type, a business process) the way existingFieldXml writes a
 * field, and the Profile file that makes a record type visible to a
 * profile and gives it a layout there. A Profile deploy overlays the
 * profile — it changes only what the file names — so the file holds only
 * that. Pure.
 */

import { developerNameOf, isDeveloperName, xmlEscape } from './metadata';
import { metadataBody, metadataFile } from './metadata-xml';
import { availableValueName } from './picklists';
import { isRecord } from '@renkei/guards';

type Json = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** An object's child component (`recordTypes`, `businessProcesses`, `fields`…), whole. */
export function objectChildXml(element: string, fullName: string, metadata: Json): string {
  return `    <${element}>\n        <fullName>${xmlEscape(fullName)}</fullName>\n${metadataBody(metadata, '        ')}    </${element}>\n`;
}

/** Objects whose record types each need a business process. */
export const PROCESS_OBJECTS: Readonly<Record<string, string>> = {
  Opportunity: 'sales process',
  Lead: 'lead process',
  Case: 'support process',
  Solution: 'solution process',
};

export interface RecordTypeSpec {
  object: string;
  /** The developer name, without the object. */
  name: string;
  label: string;
  description?: string;
  active: boolean;
  businessProcess?: string;
  /** Each picklist's values on this record type; `default` one of them. */
  picklists: { picklist: string; values: string[]; default?: string }[];
}

/**
 * A proposed record type, checked: its names, its business process where
 * the object needs one, and each picklist's values against the picklist's
 * own (`known`, by field name).
 */
export function checkRecordTypeSpec(
  input: {
    object: string;
    label?: string;
    name?: string;
    description?: string;
    active?: boolean;
    businessProcess?: string;
    picklists?: { picklist: string; values: string[]; default?: string }[];
  },
  existing: readonly { name: string; label: string }[],
  known: Readonly<Record<string, readonly string[]>>
): { ok: true; value: RecordTypeSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const label = str(input.label);
  if (!label || label.length > 80) errors.push('A record type label is 1 to 80 characters.');
  const name = str(input.name) || developerNameOf(label, 80);
  if (!isDeveloperName(name, 80)) {
    errors.push(
      `"${name || label}" does not make a record type API name: a letter first, then letters, digits and single underscores, 80 at most.`
    );
  } else if (existing.some((rt) => rt.name.toLowerCase() === name.toLowerCase())) {
    errors.push(`${input.object} already has a record type ${name}.`);
  }
  if (existing.some((rt) => rt.label.toLowerCase() === label.toLowerCase()))
    errors.push(`${input.object} already has a record type labelled “${label}”.`);
  const process = PROCESS_OBJECTS[input.object];
  if (process && !str(input.businessProcess))
    errors.push(`A ${input.object} record type needs its ${process}: name one (businessProcess).`);
  if (!process && str(input.businessProcess))
    errors.push(`${input.object} record types have no business process.`);
  const description = str(input.description);
  if (description.length > 255) errors.push('A description is 255 characters at most.');

  const picklists: RecordTypeSpec['picklists'] = [];
  for (const entry of input.picklists ?? []) {
    const fieldKey = Object.keys(known).find(
      (key) => key.toLowerCase() === entry.picklist.toLowerCase()
    );
    if (!fieldKey) {
      errors.push(`${input.object} has no picklist ${entry.picklist}.`);
      continue;
    }
    const values: string[] = [];
    for (const value of entry.values) {
      const spelled = known[fieldKey].find((k) => k.toLowerCase() === value.trim().toLowerCase());
      if (!spelled) errors.push(`${fieldKey}: "${value}" is not one of its values.`);
      else if (!values.includes(spelled)) values.push(spelled);
    }
    if (values.length === 0) {
      errors.push(`${fieldKey}: a record type offers at least one value.`);
      continue;
    }
    const wanted = entry.default?.trim();
    const defaultValue = wanted
      ? values.find((v) => v.toLowerCase() === wanted.toLowerCase())
      : undefined;
    if (wanted && !defaultValue)
      errors.push(`${fieldKey}: the default "${wanted}" is not offered.`);
    picklists.push({
      picklist: fieldKey,
      values,
      ...(defaultValue ? { default: defaultValue } : {}),
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      object: input.object,
      name,
      label,
      ...(description ? { description } : {}),
      active: input.active !== false,
      ...(process ? { businessProcess: str(input.businessProcess) } : {}),
      picklists,
    },
  };
}

/** A new record type's metadata, as objectChildXml writes it. */
export function recordTypeMetadata(spec: RecordTypeSpec): Json {
  return {
    active: spec.active,
    businessProcess: spec.businessProcess ?? null,
    description: spec.description ?? null,
    label: spec.label,
    picklistValues: spec.picklists.map((p) => ({
      picklist: p.picklist,
      values: p.values.map((value) => ({
        fullName: availableValueName(value),
        default: value === p.default,
      })),
    })),
  };
}

/** What a record type's metadata says it offers, decoded: picklist → values. */
export function recordTypePicklists(metadata: Json): { picklist: string; values: string[] }[] {
  const picklists = Array.isArray(metadata.picklistValues) ? metadata.picklistValues : [];
  return picklists.filter(isRecord).map((p) => ({
    picklist: str(p.picklist),
    values: (Array.isArray(p.values) ? p.values : []).filter(isRecord).map((v) => {
      const name = str(v.fullName);
      let shown = name;
      try {
        shown = decodeURIComponent(name);
      } catch {
        // Not encoded.
      }
      return v.default === true ? `${shown} (default)` : shown;
    }),
  }));
}

export interface ProfileRecordTypeAccess {
  /** `Object.RecordType`. */
  recordType: string;
  /** Default record type for the profile on that object. */
  default: boolean;
  /** The layout's full name (`Object-Layout Name`), or none to leave it. */
  layout?: string;
}

/**
 * The Profile file for record type access: visible (and the default, if
 * asked) and its layout. A Profile deploy overlays the profile, so this
 * changes those and nothing else.
 */
export function profileOverlayFile(access: readonly ProfileRecordTypeAccess[]): string {
  return metadataFile('Profile', {
    layoutAssignments: access
      .filter((a) => a.layout)
      .map((a) => ({ layout: a.layout, recordType: a.recordType })),
    recordTypeVisibilities: access.map((a) => ({
      default: a.default,
      recordType: a.recordType,
      visible: true,
    })),
  });
}
