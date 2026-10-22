/**
 * Picklist values wherever they live: a field's own value set, a global
 * value set (shared by every field that uses it), or a standard value set
 * (Lead Source, Industry, Opportunity Stage… — the standard fields' values,
 * which are Salesforce's own sets, some shared by several objects). And
 * which of them each record type offers — or, for the four fields a
 * business process controls (Opportunity Stage, Lead and Case Status,
 * Solution Status), each process.
 *
 * One merge for the value lists, so every place refuses the same things:
 * values are never deleted (deactivated, as Setup does — records keep
 * them), a value already there is not added twice, and a change that
 * changes nothing is refused. Pure.
 */

import { metadataFileName } from './metadata-xml';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

export interface ValueRow {
  label: string;
  value: string;
  from?: string;
}

export const FORECAST_CATEGORIES = [
  'Omitted',
  'Pipeline',
  'BestCase',
  'Forecast',
  'Closed',
] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

export interface NewValue {
  value: string;
  label?: string;
  /** Opportunity Stage: 0–100, required there. */
  probability?: number;
  /** Opportunity Stage: required there. */
  forecastCategory?: ForecastCategory;
  /** Opportunity Stage, Case and Task Status: a closed status. */
  closed?: boolean;
  /** Opportunity Stage: a won stage (closed too). */
  won?: boolean;
  /** Lead Status: a converted status. */
  converted?: boolean;
  /** Task Priority: a high priority. */
  highPriority?: boolean;
}

export interface PicklistChanges {
  add?: NewValue[];
  /** A new label for a value. The value itself (what records hold) does not change. */
  relabel?: { value: string; label: string }[];
  /** Values to stop offering; records that hold them keep them. */
  deactivate?: string[];
  /** Values to offer again. */
  activate?: string[];
  /** The values in their new order; values not named keep their order after these. */
  order?: string[];
  /** The value selected by default, or '' for none. */
  defaultValue?: string;
}

/**
 * The changes merged into a value list in place (each entry has
 * `fullName`, `label`, `default`, `isActive`), with a row per change — or
 * the errors. `newValue` builds an added entry (or says why it cannot be).
 */
export function mergeValueList(
  values: Json[],
  changes: PicklistChanges,
  newValue: (add: NewValue & { value: string }) => Json | string
): { rows: ValueRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: ValueRow[] = [];
  const find = (value: string) =>
    values.find((v) => str(v.fullName).toLowerCase() === value.trim().toLowerCase());

  for (const add of changes.add ?? []) {
    const value = add.value.trim();
    if (!value || value.length > 255) {
      errors.push(`"${value.slice(0, 40)}" is not a picklist value (1 to 255 characters).`);
      continue;
    }
    if (find(value)) {
      errors.push(`"${value}" is already a value of this picklist.`);
      continue;
    }
    const entry = newValue({ ...add, value });
    if (typeof entry === 'string') {
      errors.push(`"${value}": ${entry}`);
      continue;
    }
    values.push(entry);
    rows.push({
      label: 'Add value',
      value: add.label && add.label !== value ? `${value} (shown as “${add.label}”)` : value,
    });
  }
  for (const relabel of changes.relabel ?? []) {
    const entry = find(relabel.value);
    if (!entry) errors.push(`"${relabel.value}" is not a value of this picklist.`);
    else {
      rows.push({
        label: `Label of ${str(entry.fullName)}`,
        value: relabel.label,
        from: str(entry.label) || str(entry.fullName),
      });
      entry.label = relabel.label.trim();
    }
  }
  for (const [names, active] of [
    [changes.deactivate ?? [], false],
    [changes.activate ?? [], true],
  ] as const) {
    for (const value of names) {
      const entry = find(value);
      if (!entry) errors.push(`"${value}" is not a value of this picklist.`);
      else if ((entry.isActive !== false) === active)
        errors.push(`"${value}" is already ${active ? 'active' : 'inactive'}.`);
      else {
        entry.isActive = active;
        rows.push({ label: active ? 'Offer again' : 'Stop offering', value: str(entry.fullName) });
      }
    }
  }
  if (changes.order) {
    const named = changes.order.map((value) => find(value));
    const missing = changes.order.filter((_, index) => !named[index]);
    if (missing.length > 0) errors.push(`Not values of this picklist: ${missing.join(', ')}.`);
    else {
      const ordered = [...new Set(named.filter((v): v is Json => v !== undefined))];
      const before = values.map((v) => str(v.fullName)).join(', ');
      const rest = values.filter((v) => !ordered.includes(v));
      values.splice(0, values.length, ...ordered, ...rest);
      const after = values.map((v) => str(v.fullName)).join(', ');
      if (before !== after) rows.push({ label: 'Order', value: after, from: before });
    }
  }
  if (changes.defaultValue !== undefined) {
    const wanted = changes.defaultValue.trim();
    const current = values.find((v) => v.default === true);
    const target = wanted ? find(wanted) : undefined;
    if (wanted && !target) errors.push(`"${wanted}" is not a value of this picklist.`);
    else if (target && target.isActive === false)
      errors.push(`"${wanted}" is inactive; offer it again to make it the default.`);
    else if (str(current?.fullName) !== str(target?.fullName)) {
      for (const v of values) v.default = v === target;
      rows.push({
        label: 'Default',
        value: str(target?.fullName) || '(none)',
        from: str(current?.fullName) || '(none)',
      });
    }
  }
  return { rows, errors };
}

/** A global value set's metadata (Tooling `GlobalValueSet.Metadata`) with the changes merged in. */
export function mergeGlobalValueSetChanges(
  metadata: Json,
  changes: PicklistChanges
): { ok: true; metadata: Json; rows: ValueRow[] } | { ok: false; errors: string[] } {
  const next = structuredClone(metadata);
  const values = list(next.customValue);
  next.customValue = values;
  const merged = mergeValueList(values, changes, (add) => ({
    fullName: add.value,
    default: false,
    label: add.label?.trim() || add.value,
  }));
  if (merged.errors.length === 0 && merged.rows.length === 0)
    merged.errors.push('Nothing in that changes the value set.');
  return merged.errors.length > 0
    ? { ok: false, errors: merged.errors }
    : { ok: true, metadata: next, rows: merged.rows };
}

/**
 * Standard fields whose values are a standard value set, by `Object.Field`.
 * Several fields share one set (Lead Source on leads, contacts and
 * opportunities), so a change to one is a change to all of them.
 */
export const STANDARD_VALUE_SETS: Readonly<Record<string, string>> = {
  'Account.AccountSource': 'AccountSource',
  'Account.Industry': 'Industry',
  'Account.Ownership': 'AccountOwnership',
  'Account.Rating': 'AccountRating',
  'Account.Type': 'AccountType',
  'Campaign.Status': 'CampaignStatus',
  'Campaign.Type': 'CampaignType',
  'Case.Origin': 'CaseOrigin',
  'Case.Priority': 'CasePriority',
  'Case.Reason': 'CaseReason',
  'Case.Status': 'CaseStatus',
  'Case.Type': 'CaseType',
  'Contact.LeadSource': 'LeadSource',
  'Contact.Salutation': 'Salutation',
  'Lead.Industry': 'Industry',
  'Lead.LeadSource': 'LeadSource',
  'Lead.Rating': 'AccountRating',
  'Lead.Salutation': 'Salutation',
  'Lead.Status': 'LeadStatus',
  'Opportunity.LeadSource': 'LeadSource',
  'Opportunity.StageName': 'OpportunityStage',
  'Opportunity.Type': 'OpportunityType',
  'Product2.Family': 'Product2Family',
  'Task.Priority': 'TaskPriority',
  'Task.Status': 'TaskStatus',
};

/** Every standard field a value set is on, for "this also changes…". */
export function fieldsOfValueSet(name: string): string[] {
  return Object.entries(STANDARD_VALUE_SETS)
    .filter(([, set]) => set === name)
    .map(([field]) => field);
}

/** The standard value set a standard field takes its values from, or null. */
export function standardValueSetOf(object: string, field: string): string | null {
  const key = Object.keys(STANDARD_VALUE_SETS).find(
    (candidate) => candidate.toLowerCase() === `${object}.${field}`.toLowerCase()
  );
  return key ? STANDARD_VALUE_SETS[key] : null;
}

/**
 * Fields whose values per record type come from the record type's
 * business process (sales, lead, support, solution process), not the
 * record type itself.
 */
export const PROCESS_FIELDS: Readonly<Record<string, string>> = {
  'Opportunity.StageName': 'sales process',
  'Lead.Status': 'lead process',
  'Case.Status': 'support process',
  'Solution.Status': 'solution process',
};

export function processOf(object: string, field: string): string | null {
  const key = Object.keys(PROCESS_FIELDS).find(
    (candidate) => candidate.toLowerCase() === `${object}.${field}`.toLowerCase()
  );
  return key ? PROCESS_FIELDS[key] : null;
}

/** One value of a standard value set as read (describe, plus the status objects' flags). */
export interface StandardValueRead {
  value: string;
  label: string;
  default: boolean;
  /** Set-specific flags as the Metadata API names them (closed, won, probability…). */
  flags?: Record<string, string | number | boolean>;
}

/** A new standard value's set-specific flags, or why it needs more. */
function standardFlags(set: string, add: NewValue): Json | string {
  switch (set) {
    case 'OpportunityStage': {
      if (add.probability === undefined || add.probability < 0 || add.probability > 100)
        return 'a new stage needs its probability, 0 to 100.';
      if (!add.forecastCategory) return 'a new stage needs its forecast category.';
      const won = add.won === true;
      return {
        closed: won || add.closed === true,
        forecastCategory: add.forecastCategory,
        probability: add.probability,
        won,
      };
    }
    case 'LeadStatus':
      return { converted: add.converted === true };
    case 'CaseStatus':
    case 'TaskStatus':
      return { closed: add.closed === true };
    case 'TaskPriority':
      return { highPriority: add.highPriority === true };
    default:
      return {};
  }
}

/**
 * A standard value set's metadata with the changes merged in. It is built
 * from the values as read — active ones, with their flags — since no API
 * reads a standard value set whole; deploying one adds and changes values
 * and leaves out none that matter (inactive values the read cannot see
 * stay inactive).
 */
export function mergeStandardValueSetChanges(
  set: string,
  read: readonly StandardValueRead[],
  changes: PicklistChanges
): { ok: true; metadata: Json; rows: ValueRow[] } | { ok: false; errors: string[] } {
  if (read.length === 0) return { ok: false, errors: [`Could not read the values of ${set}.`] };
  const values: Json[] = read.map((entry) => ({
    fullName: entry.value,
    default: entry.default,
    label: entry.label || entry.value,
    ...(entry.flags ?? {}),
  }));
  const merged = mergeValueList(values, changes, (add) => {
    const flags = standardFlags(set, add);
    if (typeof flags === 'string') return flags;
    return { fullName: add.value, default: false, label: add.label?.trim() || add.value, ...flags };
  });
  if (merged.errors.length === 0 && merged.rows.length === 0)
    merged.errors.push('Nothing in that changes the picklist.');
  return merged.errors.length > 0
    ? { ok: false, errors: merged.errors }
    : { ok: true, metadata: { sorted: false, standardValue: values }, rows: merged.rows };
}

/**
 * A value as a record type or business process names it: percent-encoded
 * where the Metadata API encodes it (`Closed%2FWon`). Compared decoded.
 */
export function availableValueName(value: string): string {
  return metadataFileName(value);
}

function decodedName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface AvailabilityChange {
  /** Values to offer on this record type (or process). */
  add?: string[];
  /** Values to stop offering here (they stay on the picklist and on records). */
  remove?: string[];
  /** This record type's default, or '' for none. */
  defaultValue?: string;
}

/**
 * A list of `{fullName, default}` entries — what a record type offers of
 * one picklist, or a business process's values — with the change merged
 * in place. `known` is every value of the picklist, active or not.
 */
export function mergeAvailable(
  entries: Json[],
  change: AvailabilityChange,
  known: readonly string[],
  where: string
): { rows: ValueRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: ValueRow[] = [];
  const spelled = (value: string) =>
    known.find((k) => k.toLowerCase() === value.trim().toLowerCase());
  const has = (value: string) =>
    entries.find((e) => decodedName(str(e.fullName)).toLowerCase() === value.trim().toLowerCase());
  const before = entries.map((e) => decodedName(str(e.fullName)));

  for (const value of change.add ?? []) {
    const name = spelled(value);
    if (!name) errors.push(`"${value}" is not a value of this picklist.`);
    else if (!has(name)) entries.push({ fullName: availableValueName(name), default: false });
  }
  for (const value of change.remove ?? []) {
    const entry = has(value);
    if (!entry) errors.push(`${where} does not offer "${value}".`);
    else entries.splice(entries.indexOf(entry), 1);
  }
  if (entries.length === 0) errors.push(`${where} has to offer at least one value.`);
  if (change.defaultValue !== undefined) {
    const wanted = change.defaultValue.trim();
    const target = wanted ? has(wanted) : undefined;
    const current = entries.find((e) => e.default === true);
    if (wanted && !target)
      errors.push(`${where} does not offer "${wanted}" to make it the default.`);
    else if (current !== target) {
      for (const e of entries) e.default = e === target;
      rows.push({
        label: 'Default',
        value: target ? decodedName(str(target.fullName)) : '(none)',
        from: current ? decodedName(str(current.fullName)) : '(none)',
      });
    }
  }
  const after = entries.map((e) => decodedName(str(e.fullName)));
  const added = after.filter((v) => !before.includes(v));
  const removed = before.filter((v) => !after.includes(v));
  if (added.length) rows.push({ label: 'Offer', value: added.join(', ') });
  if (removed.length) rows.push({ label: 'Stop offering', value: removed.join(', ') });
  return { rows, errors };
}

/** A record type's metadata (Tooling `RecordType.Metadata`) with one picklist's values changed. */
export function mergeRecordTypePicklist(
  recordType: Json,
  picklist: string,
  change: AvailabilityChange,
  known: readonly string[]
): { ok: true; metadata: Json; rows: ValueRow[] } | { ok: false; errors: string[] } {
  const next = structuredClone(recordType);
  const picklists = list(next.picklistValues);
  next.picklistValues = picklists;
  const where = `Record type ${str(next.label) || 'this record type'}`;
  const entry = picklists.find((p) => str(p.picklist).toLowerCase() === picklist.toLowerCase());
  // A record type that does not list the picklist leaves its values to
  // Salesforce; listing it here with a few values would hide the rest.
  if (!entry) return { ok: false, errors: [`${where} does not list ${picklist}.`] };
  const values = list(entry.values);
  entry.values = values;
  const merged = mergeAvailable(values, change, known, where);
  if (merged.errors.length === 0 && merged.rows.length === 0)
    merged.errors.push(`${where} already offers exactly that.`);
  return merged.errors.length > 0
    ? { ok: false, errors: merged.errors }
    : { ok: true, metadata: next, rows: merged.rows };
}

/** A business process's metadata (Tooling `BusinessProcess.Metadata`) with its values changed. */
export function mergeBusinessProcessValues(
  process: Json,
  name: string,
  change: AvailabilityChange,
  known: readonly string[]
): { ok: true; metadata: Json; rows: ValueRow[] } | { ok: false; errors: string[] } {
  const next = structuredClone(process);
  const values = list(next.values);
  next.values = values;
  const merged = mergeAvailable(values, change, known, `The process ${name}`);
  if (merged.errors.length === 0 && merged.rows.length === 0)
    merged.errors.push(`The process ${name} already offers exactly that.`);
  return merged.errors.length > 0
    ? { ok: false, errors: merged.errors }
    : { ok: true, metadata: next, rows: merged.rows };
}
