/**
 * New custom report types and reports, as Metadata API components — the
 * admin connector builds them the way it builds a custom object: checked
 * here, deployed check-only by Salesforce, applied by the person
 * (docs/salesforce-connectors-design.md, "Reports and dashboards").
 *
 * A report type is a base object and up to three child relationships
 * joined down from it, with sections of columns; a report names its report
 * type, its format, columns, groupings, filters and date range, and lives
 * in a report folder — an existing one, or a new one deployed with it.
 *
 * The Metadata API takes elements in its schema's order, so every element
 * here is written in that order (metadataFile keeps insertion order). Pure.
 */

import { developerNameOf, isDeveloperName, packageXml, type PackageMember } from './metadata';
import { metadataFile } from './metadata-xml';
import type { ChangeRow } from './changes';
import { isRecord } from '@renkei/guards';

type Json = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const REPORT_TYPE_CATEGORIES = [
  'accounts',
  'opportunities',
  'forecasts',
  'cases',
  'leads',
  'campaigns',
  'activities',
  'busop',
  'products',
  'admin',
  'territory',
  'other',
  'content',
  'quotes',
] as const;
export type ReportTypeCategory = (typeof REPORT_TYPE_CATEGORIES)[number];

/** What a proposal needs to know of an object to build a report type over it. */
export interface ReportObjectInfo {
  name: string;
  labelPlural: string;
  /** Field API names the describe lists, the name field first when known. */
  fields: string[];
  /** The name field, checked by default. */
  nameField?: string;
  /** Lookup relationship names (`Owner`, `Program__r`), for dotted columns. */
  lookups: string[];
  /** Child relationship name → the child object. */
  children: Record<string, string>;
}

export interface ReportTypeColumn {
  field: string;
  checked: boolean;
}

export interface ReportTypeSection {
  label: string;
  /** `Base` or `Base.Child__r` — the join path the columns come from. */
  table: string;
  columns: ReportTypeColumn[];
}

export interface ReportTypeSpec {
  /** Without `__c`; reports name it with `__c`. */
  developerName: string;
  label: string;
  description: string;
  category: ReportTypeCategory;
  baseObject: string;
  joins: Array<{ relationship: string; object: string; outerJoin: boolean }>;
  sections: ReportTypeSection[];
  deployed: boolean;
}

/** Field types a report type column cannot carry (the parts of a compound can). */
const NOT_COLUMNS = new Set(['address', 'location', 'base64']);

/** The describe's fields a report type offers by default. */
export function reportableFields(
  fields: ReadonlyArray<{
    name: string;
    type?: string;
    nameField?: boolean;
    referenceTo?: readonly string[];
  }>
): { fields: string[]; nameField?: string } {
  // A lookup that can point at more than one object (an owner that may be a
  // user or a queue) is refused in a report type's layout.
  const usable = fields.filter(
    (field) =>
      !NOT_COLUMNS.has(String(field.type ?? '')) &&
      !(field.type === 'reference' && (field.referenceTo?.length ?? 0) > 1)
  );
  const nameField = usable.find((field) => field.nameField)?.name;
  return {
    fields: [
      ...(nameField ? [nameField] : []),
      ...usable.map((field) => field.name).filter((name) => name !== nameField),
    ],
    ...(nameField ? { nameField } : {}),
  };
}

/**
 * A proposed report type, checked against the objects it joins: the base
 * object, each relationship a child relationship of the object before it,
 * no inner join after an outer one, and every column a field (or a lookup
 * path) of its section's object. Sections default to one per object with
 * every field, the name field checked.
 */
export function checkReportTypeSpec(
  input: unknown,
  objects: (name: string) => ReportObjectInfo | undefined
): Checked<ReportTypeSpec> {
  const entry = isRecord(input) ? input : {};
  const errors: string[] = [];
  const label = str(entry.label);
  if (!label || label.length > 50) errors.push('A report type label is 1 to 50 characters.');
  const developerName = str(entry.apiName).replace(/__c$/i, '') || developerNameOf(label, 50);
  if (!isDeveloperName(developerName, 50)) {
    errors.push(
      `"${developerName || label}" does not make a report type API name: a letter first, then letters, digits and single underscores, 50 at most.`
    );
  }
  const description = str(entry.description) || label;
  if (description.length > 255) errors.push('A report type description is 255 characters at most.');
  const categoryText = str(entry.category) || 'other';
  const category = REPORT_TYPE_CATEGORIES.find((c) => c === categoryText);
  if (!category) {
    errors.push(`The category is one of ${REPORT_TYPE_CATEGORIES.join(', ')}.`);
  }

  const base = objects(str(entry.baseObject));
  if (!base) {
    errors.push(`There is no object ${str(entry.baseObject) || '(none given)'} to report on.`);
    return { ok: false, errors };
  }
  // The join path: each table's name, and the object behind it.
  const tables: Array<{ table: string; info: ReportObjectInfo }> = [
    { table: base.name, info: base },
  ];
  const joins: ReportTypeSpec['joins'] = [];
  const rawJoins = Array.isArray(entry.joins) ? entry.joins : [];
  if (rawJoins.length > 3) errors.push('A report type joins at most three objects to its base.');
  let outer = false;
  for (const raw of rawJoins.slice(0, 3)) {
    const join = isRecord(raw) ? raw : {};
    const parent = tables[tables.length - 1];
    const wanted = str(join.relationship);
    const relationship = Object.keys(parent.info.children).find(
      (name) => name.toLowerCase() === wanted.toLowerCase()
    );
    const child = relationship ? objects(parent.info.children[relationship]) : undefined;
    if (!relationship || !child) {
      const offered = Object.keys(parent.info.children).slice(0, 20);
      errors.push(
        `${parent.info.name} has no child relationship ${wanted || '(none given)'}` +
          (offered.length ? ` — it has ${offered.join(', ')}.` : '.')
      );
      break;
    }
    const outerJoin = join.outerJoin === true;
    if (outer && !outerJoin) {
      errors.push(
        `${relationship}: an inner join cannot follow an outer one — make it "with or without" too, or reorder.`
      );
    }
    outer = outer || outerJoin;
    joins.push({ relationship, object: child.name, outerJoin });
    tables.push({ table: `${parent.table}.${relationship}`, info: child });
  }

  const tableFor = (ref: string) => {
    const wanted = ref.toLowerCase();
    return tables.find(
      ({ table, info }) =>
        table.toLowerCase() === wanted ||
        table.split('.').pop()?.toLowerCase() === wanted ||
        info.name.toLowerCase() === wanted
    );
  };
  const sections: ReportTypeSection[] = [];
  const rawSections = Array.isArray(entry.sections) ? entry.sections : [];
  if (rawSections.length === 0) {
    for (const { table, info } of tables) {
      sections.push({
        label: info.labelPlural,
        table,
        columns: info.fields.map((field) => ({ field, checked: field === info.nameField })),
      });
    }
  }
  for (const raw of rawSections) {
    const section = isRecord(raw) ? raw : {};
    const found = tableFor(str(section.object));
    if (!found) {
      errors.push(
        `A section’s object is one of ${tables.map((t) => t.table).join(', ')}, not ${str(section.object) || '(none given)'}.`
      );
      continue;
    }
    const sectionLabel = str(section.label) || found.info.labelPlural;
    const checked = new Set(
      (Array.isArray(section.checked) ? section.checked : []).map((f) => str(f).toLowerCase())
    );
    const named = Array.isArray(section.fields) ? section.fields.map(str).filter(Boolean) : [];
    const columns: ReportTypeColumn[] = [];
    for (const name of named.length > 0 ? named : found.info.fields) {
      const field = reportColumnOf(found.info, name);
      if (!field) {
        errors.push(`${sectionLabel}: ${found.info.name} has no field ${name}.`);
        continue;
      }
      if (columns.some((c) => c.field.toLowerCase() === field.toLowerCase())) continue;
      columns.push({
        field,
        checked:
          checked.has(field.toLowerCase()) ||
          (checked.size === 0 && field === found.info.nameField),
      });
    }
    sections.push({ label: sectionLabel, table: found.table, columns });
  }
  const total = sections.reduce((sum, s) => sum + s.columns.length, 0);
  if (total === 0) errors.push('A report type with no columns offers nothing to report on.');
  if (total > 1000) errors.push('A report type offers at most 1,000 columns.');

  if (errors.length > 0 || !category) return { ok: false, errors };
  return {
    ok: true,
    value: {
      developerName,
      label,
      description,
      category,
      baseObject: base.name,
      joins,
      sections,
      deployed: entry.deployed !== false,
    },
  };
}

/** A field name, or a lookup path (`Owner.Email`) through one of the object's lookups. */
export function reportColumnOf(info: ReportObjectInfo, name: string): string | null {
  const [head, ...rest] = name.split('.');
  if (rest.length === 0) {
    return info.fields.find((field) => field.toLowerCase() === head.toLowerCase()) ?? null;
  }
  const lookup = info.lookups.find((l) => l.toLowerCase() === head.toLowerCase());
  return lookup && rest.every((part) => /^[A-Za-z][A-Za-z0-9_]*$/.test(part))
    ? [lookup, ...rest].join('.')
    : null;
}

function joinElement(joins: ReportTypeSpec['joins']): Json | null {
  const [first, ...rest] = joins;
  if (!first) return null;
  return {
    join: joinElement(rest),
    outerJoin: first.outerJoin,
    relationship: first.relationship,
  };
}

/** The report type's file and manifest member. */
export function buildReportTypePackage(spec: ReportTypeSpec): {
  files: Record<string, string>;
  members: PackageMember[];
} {
  const members: PackageMember[] = [{ type: 'ReportType', member: spec.developerName }];
  return {
    files: {
      'package.xml': packageXml(members),
      [`reportTypes/${spec.developerName}.reportType`]: metadataFile('ReportType', {
        baseObject: spec.baseObject,
        category: spec.category,
        deployed: spec.deployed,
        description: spec.description,
        join: joinElement(spec.joins),
        label: spec.label,
        sections: spec.sections.map((section) => ({
          columns: section.columns.map((column) => ({
            checkedByDefault: column.checked,
            field: column.field,
            table: section.table,
          })),
          masterLabel: section.label,
        })),
      }),
    },
    members,
  };
}

// ——— reports ———

export const REPORT_FORMATS = ['Tabular', 'Summary', 'Matrix'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_SUMMARIES = [
  'Sum',
  'Average',
  'Maximum',
  'Minimum',
  'Unique',
  'Median',
] as const;
export type ReportSummary = (typeof REPORT_SUMMARIES)[number];

export const REPORT_FILTER_OPERATORS = [
  'equals',
  'notEqual',
  'lessThan',
  'greaterThan',
  'lessOrEqual',
  'greaterOrEqual',
  'contains',
  'notContain',
  'startsWith',
  'includes',
  'excludes',
] as const;
export type ReportFilterOperator = (typeof REPORT_FILTER_OPERATORS)[number];

export const DATE_GRANULARITIES = [
  'Day',
  'Week',
  'Month',
  'Quarter',
  'Year',
  'FiscalQuarter',
  'FiscalYear',
  'MonthInYear',
  'DayInMonth',
] as const;
export type DateGranularity = (typeof DATE_GRANULARITIES)[number];

/** The relative ranges a report's date filter takes most often; INTERVAL_CUSTOM takes dates. */
export const DATE_INTERVALS = [
  'INTERVAL_TODAY',
  'INTERVAL_YESTERDAY',
  'INTERVAL_THISWEEK',
  'INTERVAL_LASTWEEK',
  'INTERVAL_THISMONTH',
  'INTERVAL_LASTMONTH',
  'INTERVAL_CURRENTQ',
  'INTERVAL_PREVQ',
  'INTERVAL_CURY',
  'INTERVAL_PREVY',
  'INTERVAL_CURRENT',
  'INTERVAL_PREV1',
  'INTERVAL_CURFY',
  'INTERVAL_PREVFY',
  'INTERVAL_LAST7',
  'INTERVAL_LAST30',
  'INTERVAL_LAST60',
  'INTERVAL_LAST90',
  'INTERVAL_LAST120',
  'INTERVAL_NEXT7',
  'INTERVAL_NEXT30',
  'INTERVAL_NEXT90',
  'INTERVAL_CUSTOM',
] as const;
export type DateInterval = (typeof DATE_INTERVALS)[number];

export const FOLDER_ACCESS = ['ReadOnly', 'ReadWrite', 'Hidden'] as const;
export type FolderAccess = (typeof FOLDER_ACCESS)[number];

export interface ReportGrouping {
  field: string;
  sortOrder: 'Asc' | 'Desc';
  dateGranularity?: DateGranularity;
}

export interface ReportSpec {
  name: string;
  developerName: string;
  description?: string;
  reportType: string;
  format: ReportFormat;
  columns: Array<{ field: string; aggregates: ReportSummary[] }>;
  groupingsDown: ReportGrouping[];
  groupingsAcross: ReportGrouping[];
  filters: Array<{ column: string; operator: ReportFilterOperator; value: string }>;
  filterLogic?: string;
  /**
   * `relative` is a range that moves with the day the report is run
   * (`LAST_N_MONTHS:12`): the report's own time frame only takes fixed
   * dates and Salesforce's named intervals, so it is written as a filter on
   * the column, ANDed with the others.
   */
  dateFilter?: {
    column: string;
    interval: DateInterval;
    start?: string;
    end?: string;
    relative?: string;
  };
  scope?: string;
  sort?: { column: string; order: 'Asc' | 'Desc' };
  showDetails: boolean;
  /** The folder's developer name. */
  folder: string;
  /** Set when the folder is new and deploys with the report. */
  newFolder?: { label: string; access: FolderAccess };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const RELATIVE_FIXED = new Set([
  'TODAY',
  'YESTERDAY',
  'TOMORROW',
  'LAST_90_DAYS',
  'NEXT_90_DAYS',
  ...['WEEK', 'MONTH', 'QUARTER', 'YEAR', 'FISCAL_QUARTER', 'FISCAL_YEAR'].flatMap((unit) => [
    `THIS_${unit}`,
    `LAST_${unit}`,
    `NEXT_${unit}`,
  ]),
]);
const RELATIVE_UNITS = 'DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS';
const RELATIVE_COUNTED = new RegExp(`^(LAST|NEXT)_N_(${RELATIVE_UNITS}):(\\d+)$`);
const RELATIVE_AGO = new RegExp(`^N_(${RELATIVE_UNITS})_AGO:(\\d+)$`);
const RELATIVE_SPOKEN = new RegExp(`^(LAST|NEXT)_(\\d+)_(${RELATIVE_UNITS})$`);
const RELATIVE_SPOKEN_AGO = new RegExp(`^(\\d+)_(${RELATIVE_UNITS})_AGO$`);

/**
 * A relative date value as a report filter takes it — `LAST_N_MONTHS:12`,
 * `LAST_N_DAYS:365`, `THIS_YEAR`, `N_DAYS_AGO:30` — from that or from the
 * words for it ("last 12 months", "30 days ago"); null when it is neither.
 * A count is 1 to 9,999.
 */
export function relativeDateLiteral(text: string): string | null {
  const value = text
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '_')
    .replace(/_?:_?/, ':');
  if (RELATIVE_FIXED.has(value)) return value;
  const spoken = RELATIVE_SPOKEN.exec(value);
  const spokenAgo = RELATIVE_SPOKEN_AGO.exec(value);
  const literal = spoken
    ? `${spoken[1]}_N_${spoken[3]}:${spoken[2]}`
    : spokenAgo
      ? `N_${spokenAgo[2]}_AGO:${spokenAgo[1]}`
      : value;
  const counted = RELATIVE_COUNTED.exec(literal) ?? RELATIVE_AGO.exec(literal);
  if (!counted) return null;
  const n = Number(counted[counted.length - 1]);
  if (n < 1 || n > 9999) return null;
  // Without leading zeros.
  return literal.replace(/:\d+$/, `:${n}`);
}

/** A relative date value in words: `LAST_N_MONTHS:12` is "last 12 months". */
export function relativeDateWords(literal: string): string {
  const counted = RELATIVE_COUNTED.exec(literal);
  if (counted) return `${counted[1]} ${counted[3]} ${counted[2]}`.replace(/_/g, ' ').toLowerCase();
  const ago = RELATIVE_AGO.exec(literal);
  if (ago) return `${ago[2]} ${ago[1]} ago`.replace(/_/g, ' ').toLowerCase();
  return literal.replace(/_/g, ' ').toLowerCase();
}

function groupingsOf(raw: unknown, label: string, errors: string[]): ReportGrouping[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item): ReportGrouping[] => {
    const entry: Json = isRecord(item) ? item : { field: item };
    const field = str(entry.field);
    if (!field) {
      errors.push(`${label}: each grouping names a field.`);
      return [];
    }
    const granularity = str(entry.dateGranularity);
    const dateGranularity = DATE_GRANULARITIES.find((g) => g === granularity);
    if (granularity && !dateGranularity) {
      errors.push(`${field}: a date grouping is by ${DATE_GRANULARITIES.join(', ')}.`);
    }
    return [
      {
        field,
        sortOrder: entry.sortOrder === 'Desc' ? 'Desc' : 'Asc',
        ...(dateGranularity ? { dateGranularity } : {}),
      },
    ];
  });
}

/** Why a format does not fit its groupings: tabular none, summary rows, matrix both ways. */
export function groupingProblems(format: ReportFormat, down: number, across: number): string[] {
  const errors: string[] = [];
  if (format === 'Tabular' && (down > 0 || across > 0)) {
    errors.push(
      'A tabular report has no groupings; make it Summary (rows) or Matrix (rows and columns).'
    );
  }
  if (format === 'Summary') {
    if (down === 0) errors.push('A summary report groups its rows by at least one field.');
    if (down > 3) errors.push('A summary report groups by three fields at most.');
    if (across > 0) errors.push('Only a matrix report groups columns.');
  }
  if (format === 'Matrix') {
    if (down === 0 || across === 0) {
      errors.push('A matrix report groups both rows and columns, by at least one field each.');
    }
    if (down > 2 || across > 2) {
      errors.push('A matrix report groups by two fields at most each way.');
    }
  }
  return errors;
}

/**
 * Filter logic over numbered filters (`1 AND (2 OR 3)`): only numbers that
 * name a filter, AND, OR, NOT and balanced parentheses — and every filter
 * used, as Salesforce requires.
 */
export function checkFilterLogic(logic: string, filters: number): string | null {
  const tokens = logic.toUpperCase().match(/\d+|AND|OR|NOT|\(|\)|\S+/g) ?? [];
  let depth = 0;
  const used = new Set<number>();
  for (const token of tokens) {
    if (token === '(') depth += 1;
    else if (token === ')') {
      depth -= 1;
      if (depth < 0) return 'The filter logic’s parentheses do not balance.';
    } else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 1 || n > filters)
        return `The filter logic names filter ${n}, and there are ${filters}.`;
      used.add(n);
    } else if (!['AND', 'OR', 'NOT'].includes(token)) {
      return `The filter logic has "${token}"; it takes filter numbers, AND, OR, NOT and parentheses.`;
    }
  }
  if (depth !== 0) return 'The filter logic’s parentheses do not balance.';
  if (used.size !== filters) return 'The filter logic must use every filter.';
  return null;
}

/**
 * A proposed report, checked: its names, a format its groupings fit
 * (tabular none, summary up to three down, matrix one or two each way),
 * columns, filters and their logic, a date range, and a folder — `folder`
 * an existing one's developer name, or `newFolder` with the access everyone
 * gets to it. Column names are the report type's; Salesforce's validation
 * deploy checks each one against it.
 */
export function checkReportSpec(
  input: unknown,
  folder:
    { existing: string } | { create: { label: string; developerName?: string; access?: string } }
): Checked<ReportSpec> {
  const entry = isRecord(input) ? input : {};
  const errors: string[] = [];
  const name = str(entry.name);
  if (!name || name.length > 40) errors.push('A report name is 1 to 40 characters.');
  const developerName = str(entry.apiName) || developerNameOf(name, 80);
  if (!isDeveloperName(developerName, 80)) {
    errors.push(
      `"${developerName || name}" does not make a report API name: a letter first, then letters, digits and single underscores, 80 at most.`
    );
  }
  const description = str(entry.description);
  if (description.length > 255) errors.push('A report description is 255 characters at most.');
  const reportType = str(entry.reportType);
  if (!reportType) errors.push('Name the report type (salesforce_admin_list_report_types).');
  const formatText = str(entry.format) || 'Tabular';
  const format = REPORT_FORMATS.find((f) => f === formatText);
  if (!format) errors.push(`The format is one of ${REPORT_FORMATS.join(', ')}.`);

  const groupingsDown = groupingsOf(entry.groupingsDown, 'Row groupings', errors);
  const groupingsAcross = groupingsOf(entry.groupingsAcross, 'Column groupings', errors);
  if (format)
    errors.push(...groupingProblems(format, groupingsDown.length, groupingsAcross.length));
  const grouped = new Set([...groupingsDown, ...groupingsAcross].map((g) => g.field.toLowerCase()));

  const columns: ReportSpec['columns'] = [];
  for (const raw of Array.isArray(entry.columns) ? entry.columns : []) {
    const column: Json = isRecord(raw) ? raw : { field: raw };
    const field = str(column.field);
    if (!field) continue;
    // A grouped field is the grouping's heading, not a column as well.
    if (grouped.has(field.toLowerCase())) continue;
    if (columns.some((c) => c.field.toLowerCase() === field.toLowerCase())) continue;
    const aggregates: ReportSummary[] = [];
    for (const aggregate of Array.isArray(column.aggregates) ? column.aggregates : []) {
      const known = REPORT_SUMMARIES.find((s) => s === str(aggregate));
      if (known) aggregates.push(known);
      else errors.push(`${field}: a summary is one of ${REPORT_SUMMARIES.join(', ')}.`);
    }
    columns.push({ field, aggregates });
  }
  if (columns.length === 0) errors.push('A report shows at least one column.');
  if (columns.length > 100) errors.push('A report shows 100 columns at most.');

  const filters: ReportSpec['filters'] = [];
  for (const raw of Array.isArray(entry.filters) ? entry.filters : []) {
    const filter = isRecord(raw) ? raw : {};
    const column = str(filter.column);
    const operator = REPORT_FILTER_OPERATORS.find((o) => o === str(filter.operator));
    if (!column || !operator) {
      errors.push(
        `Each filter names a column and an operator (${REPORT_FILTER_OPERATORS.join(', ')}).`
      );
      continue;
    }
    filters.push({
      column,
      operator,
      value: typeof filter.value === 'string' ? filter.value : String(filter.value ?? ''),
    });
  }
  if (filters.length > 20) errors.push('A report takes 20 filters at most.');
  const filterLogic = str(entry.filterLogic);
  if (filterLogic) {
    const problem = checkFilterLogic(filterLogic, filters.length);
    if (problem) errors.push(problem);
  }

  let dateFilter: ReportSpec['dateFilter'];
  const range = isRecord(entry.dateFilter) ? entry.dateFilter : null;
  if (range) {
    const column = str(range.column);
    const interval = DATE_INTERVALS.find((i) => i === (str(range.interval) || 'INTERVAL_CUSTOM'));
    const start = str(range.start);
    const end = str(range.end);
    const relativeText = str(range.relative);
    const relative = relativeText ? relativeDateLiteral(relativeText) : null;
    if (!column) errors.push('A date range names its date column.');
    if (relativeText) {
      if (!relative) {
        errors.push(
          `"${relativeText}" is not a relative date range: LAST_N_DAYS:365, LAST_N_MONTHS:12, NEXT_N_WEEKS:4, THIS_YEAR, LAST_QUARTER…`
        );
      }
      if (str(range.interval) || start || end) {
        errors.push('A date range is relative, an interval, or start and end dates: one of them.');
      }
      if (filters.length >= 20) {
        errors.push('A relative date range counts as a filter, and a report takes 20 at most.');
      }
      if (column && relative) dateFilter = { column, interval: 'INTERVAL_CUSTOM', relative };
    } else {
      if (!interval) errors.push(`A date range is one of ${DATE_INTERVALS.join(', ')}.`);
      if ((start && !ISO_DATE.test(start)) || (end && !ISO_DATE.test(end))) {
        errors.push('A date range’s start and end are YYYY-MM-DD.');
      }
      if (interval === 'INTERVAL_CUSTOM' && !start && !end) {
        errors.push('A custom date range has a start, an end, or both.');
      }
    }
    if (!relativeText && column && interval) {
      dateFilter = {
        column,
        interval,
        ...(interval === 'INTERVAL_CUSTOM' && start ? { start } : {}),
        ...(interval === 'INTERVAL_CUSTOM' && end ? { end } : {}),
      };
    }
  }

  let sort: ReportSpec['sort'];
  if (isRecord(entry.sort) && str(entry.sort.column)) {
    sort = { column: str(entry.sort.column), order: entry.sort.order === 'Desc' ? 'Desc' : 'Asc' };
  }

  let folderName: string;
  let newFolder: ReportSpec['newFolder'];
  if ('existing' in folder) {
    folderName = folder.existing;
  } else {
    const label = folder.create.label.trim();
    if (!label || label.length > 40) errors.push('A folder name is 1 to 40 characters.');
    folderName = folder.create.developerName?.trim() || developerNameOf(label);
    if (!isDeveloperName(folderName)) {
      errors.push(`"${folderName || label}" does not make a folder API name.`);
    }
    const access = FOLDER_ACCESS.find((a) => a === (folder.create.access || 'ReadOnly'));
    if (!access) errors.push(`A new folder’s access is one of ${FOLDER_ACCESS.join(', ')}.`);
    newFolder = { label, access: access ?? 'ReadOnly' };
  }

  if (errors.length > 0 || !format) return { ok: false, errors };
  const scope = str(entry.scope);
  return {
    ok: true,
    value: {
      name,
      developerName,
      ...(description ? { description } : {}),
      reportType,
      format,
      columns,
      groupingsDown,
      groupingsAcross,
      filters,
      ...(filterLogic ? { filterLogic } : {}),
      ...(dateFilter ? { dateFilter } : {}),
      ...(scope ? { scope } : {}),
      ...(sort ? { sort } : {}),
      showDetails: entry.showDetails !== false,
      folder: folderName,
      ...(newFolder ? { newFolder } : {}),
    },
  };
}

const groupingElement = (grouping: ReportGrouping): Json => ({
  dateGranularity: grouping.dateGranularity ?? null,
  field: grouping.field,
  sortOrder: grouping.sortOrder,
});

/** The report's file — and its folder's, when the folder is new — with the manifest. */
export function buildReportPackage(spec: ReportSpec): {
  files: Record<string, string>;
  members: PackageMember[];
} {
  const members: PackageMember[] = [
    ...(spec.newFolder ? [{ type: 'Report', member: spec.folder }] : []),
    { type: 'Report', member: `${spec.folder}/${spec.developerName}` },
  ];
  // A relative range is one more filter, ANDed with whatever the logic says.
  const relative = spec.dateFilter?.relative;
  const filters = relative
    ? [
        ...spec.filters,
        { column: spec.dateFilter?.column ?? '', operator: 'equals' as const, value: relative },
      ]
    : spec.filters;
  const filterLogic =
    spec.filterLogic && relative ? `(${spec.filterLogic}) AND ${filters.length}` : spec.filterLogic;
  const report = metadataFile('Report', {
    columns: spec.columns.map((column) => ({
      aggregateTypes: column.aggregates.length > 0 ? column.aggregates : null,
      field: column.field,
    })),
    description: spec.description ?? null,
    filter:
      filters.length > 0
        ? {
            booleanFilter: filterLogic ?? null,
            criteriaItems: filters.map((filter) => ({
              column: filter.column,
              columnToColumn: false,
              isUnlocked: true,
              operator: filter.operator,
              value: filter.value,
            })),
          }
        : null,
    format: spec.format,
    groupingsAcross:
      spec.groupingsAcross.length > 0 ? spec.groupingsAcross.map(groupingElement) : null,
    groupingsDown: spec.groupingsDown.length > 0 ? spec.groupingsDown.map(groupingElement) : null,
    name: spec.name,
    reportType: spec.reportType,
    scope: spec.scope ?? null,
    showDetails: spec.showDetails,
    showGrandTotal: true,
    showSubTotals: true,
    sortColumn: spec.sort?.column ?? null,
    sortOrder: spec.sort?.order ?? null,
    timeFrameFilter:
      spec.dateFilter && !relative
        ? {
            dateColumn: spec.dateFilter.column,
            endDate: spec.dateFilter.end ?? null,
            interval: spec.dateFilter.interval,
            startDate: spec.dateFilter.start ?? null,
          }
        : null,
  });
  const files: Record<string, string> = {
    'package.xml': packageXml(members),
    [`reports/${spec.folder}/${spec.developerName}.report`]: report,
  };
  if (spec.newFolder) {
    files[`reports/${spec.folder}-meta.xml`] = metadataFile(
      'ReportFolder',
      spec.newFolder.access === 'Hidden'
        ? { accessType: 'Hidden', name: spec.newFolder.label }
        : {
            accessType: 'Public',
            name: spec.newFolder.label,
            publicFolderAccess: spec.newFolder.access,
          }
    );
  }
  return { files, members };
}

// ——— changes to an existing report type ———

const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];

/**
 * A report type read whole (readMetadata), with its repeated elements
 * always arrays — sections, and each section's columns — so a change and
 * its fingerprint do not depend on whether there happened to be one.
 */
export function normalizeReportType(metadata: Json): Json {
  const next = structuredClone(metadata);
  next.sections = list(next.sections)
    .filter(isRecord)
    .map((section) => ({ ...section, columns: list(section.columns).filter(isRecord) }));
  return next;
}

/** A report type's tables: its base object, then each join down from it (`Base.Child__r`). */
export function reportTypeTables(metadata: Json): string[] {
  const tables = [str(metadata.baseObject)];
  let join = isRecord(metadata.join) ? metadata.join : null;
  while (join) {
    tables.push(`${tables[tables.length - 1]}.${str(join.relationship)}`);
    join = isRecord(join.join) ? join.join : null;
  }
  return tables.filter(Boolean);
}

export interface ReportTypeColumnAdd {
  /** A section's label: an existing one gains the column, a new one is made. */
  section: string;
  /** One of reportTypeTables. */
  table: string;
  field: string;
  checked: boolean;
}

export interface ReportTypeColumnRemove {
  /** One of reportTypeTables. */
  table: string;
  field: string;
}

export interface ReportTypeEdit {
  adds?: readonly ReportTypeColumnAdd[];
  removes?: readonly ReportTypeColumnRemove[];
  label?: string;
  description?: string;
  /** Whether report builders can use it (false: in development). */
  deployed?: boolean;
}

/** The ReportType schema's element order, for an element the read did not carry. */
const REPORT_TYPE_ELEMENTS = [
  'fullName',
  'autogenerated',
  'baseObject',
  'category',
  'deployed',
  'description',
  'join',
  'label',
  'sections',
];

function setElement(metadata: Json, key: string, value: unknown): void {
  if (key in metadata) {
    metadata[key] = value;
    return;
  }
  const rank = (name: string) => {
    const at = REPORT_TYPE_ELEMENTS.indexOf(name);
    return at < 0 ? REPORT_TYPE_ELEMENTS.length : at;
  };
  const added: [string, unknown] = [key, value];
  const entries = [...Object.entries(metadata), added];
  for (const name of Object.keys(metadata)) delete metadata[name];
  entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry[0]) - rank(b.entry[0]) || a.index - b.index)
    .forEach(({ entry }) => {
      metadata[entry[0]] = entry[1];
    });
}

/**
 * A report type changed, and its rows for the review page — or why not. A
 * report type deploys whole, so everything the change does not name stays
 * exactly as read. Columns are taken away first (a section left empty goes
 * with them), then added at the end of their section (a new section at the
 * end), never moved; the label, description and whether it is deployed are
 * replaced. Refused: a column to remove that is not offered, one to add
 * that already is, a table the type does not join, taking the last column,
 * and a change that changes nothing.
 */
export function editReportType(
  metadata: Json,
  edit: ReportTypeEdit
): { ok: true; metadata: Json; rows: ChangeRow[] } | { ok: false; errors: string[] } {
  const next = normalizeReportType(metadata);
  let sections = list(next.sections).filter(isRecord);
  const tables = reportTypeTables(next);
  const errors: string[] = [];
  const rows: ChangeRow[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const columnsOf = (section: Json) => list(section.columns).filter(isRecord);

  const label = edit.label?.trim();
  if (label !== undefined && label !== str(next.label)) {
    if (!label || label.length > 50) errors.push('A report type label is 1 to 50 characters.');
    else {
      rows.push({ label: 'Label', value: `${str(next.label)} → ${label}` });
      setElement(next, 'label', label);
    }
  }
  const description = edit.description?.trim();
  if (description !== undefined && description !== str(next.description)) {
    if (!description || description.length > 255) {
      errors.push('A report type description is 1 to 255 characters.');
    } else {
      rows.push({ label: 'Description', value: description });
      setElement(next, 'description', description);
    }
  }
  if (edit.deployed !== undefined && edit.deployed !== (String(next.deployed) === 'true')) {
    rows.push({
      label: 'Available to users',
      value: edit.deployed ? 'yes' : 'no (in development): its reports stop running until it is',
    });
    setElement(next, 'deployed', edit.deployed ? 'true' : 'false');
  }

  const removed = new Map<string, string[]>();
  for (const remove of edit.removes ?? []) {
    const table = tables.find((t) => same(t, remove.table));
    const holder =
      table &&
      sections.find((section) =>
        columnsOf(section).some(
          (column) => same(str(column.table), table) && same(str(column.field), remove.field)
        )
      );
    if (!table || !holder) {
      errors.push(
        `${remove.field} (${table ?? remove.table}) is not in the report type, so it cannot be taken out.`
      );
      continue;
    }
    holder.columns = columnsOf(holder).filter(
      (column) => !(same(str(column.table), table) && same(str(column.field), remove.field))
    );
    const key = str(holder.masterLabel);
    removed.set(key, [...(removed.get(key) ?? []), remove.field]);
  }
  for (const [section, fields] of removed) {
    const emptied = sections.some(
      (s) => str(s.masterLabel) === section && columnsOf(s).length === 0
    );
    rows.push({
      label: `Section “${section}”`,
      value: `takes out ${fields.join(', ')}${emptied ? '; the section, now empty, goes too' : ''} — reports showing ${fields.length === 1 ? 'it lose that column' : 'them lose those columns'}`,
    });
  }

  const added = new Map<string, string[]>();
  const has = (table: string, field: string) =>
    sections.find((section) =>
      columnsOf(section).some(
        (column) => same(str(column.table), table) && same(str(column.field), field)
      )
    );
  for (const add of edit.adds ?? []) {
    const table = tables.find((t) => same(t, add.table));
    if (!table) {
      errors.push(
        `${add.field}: the report type’s tables are ${tables.join(', ')}, not ${add.table}.`
      );
      continue;
    }
    const holder = has(table, add.field);
    if (holder) {
      errors.push(
        `${add.field} (${table}) is already in the section “${str(holder.masterLabel)}”.`
      );
      continue;
    }
    const sectionLabel = add.section.trim();
    if (!sectionLabel || sectionLabel.length > 80) {
      errors.push('A section label is 1 to 80 characters.');
      continue;
    }
    let section = sections.find((s) => same(str(s.masterLabel), sectionLabel));
    if (!section) {
      section = { columns: [], masterLabel: sectionLabel };
      sections.push(section);
    }
    const columns = columnsOf(section);
    columns.push({ checkedByDefault: add.checked ? 'true' : 'false', field: add.field, table });
    section.columns = columns;
    const key = str(section.masterLabel);
    added.set(key, [
      ...(added.get(key) ?? []),
      `${add.field}${add.checked ? ' (shown by default)' : ''}`,
    ]);
  }
  for (const [section, fields] of added) {
    rows.push({ label: `Section “${section}”`, value: `adds ${fields.join(', ')}` });
  }

  sections = sections.filter((section) => columnsOf(section).length > 0);
  next.sections = sections;
  if (errors.length === 0 && sections.length === 0) {
    errors.push('A report type with no columns offers nothing to report on.');
  }
  if (errors.length === 0 && rows.length === 0)
    errors.push('Nothing in that changes the report type.');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, metadata: next, rows };
}

/** A report type with columns added (editReportType, additions only). */
export function mergeReportTypeColumns(
  metadata: Json,
  adds: readonly ReportTypeColumnAdd[]
): { ok: true; metadata: Json; rows: ChangeRow[] } | { ok: false; errors: string[] } {
  return editReportType(metadata, { adds });
}

/**
 * The name a report file gives a custom report type's column, from the name
 * its describe gives it. The describe joins everything with dots
 * (`Referral.Client.Name`); the file puts a `$` between the table — the base
 * object and the child relationships joined down from it — and the field,
 * which may itself be a lookup path: `Referral$Client.Name`,
 * `Site_Visit__c.Visit_Notes__r$Owner.Email`. `childrenOf` gives an object's
 * child relationship names and the object each leads to; a name already
 * holding a `$` is returned as it is.
 */
export function reportFileColumn(
  describeName: string,
  childrenOf: (object: string) => Record<string, string> | undefined
): string {
  if (describeName.includes('$')) return describeName;
  const parts = describeName.split('.');
  if (parts.length < 2) return describeName;
  const table = [parts[0]];
  let object = parts[0];
  let at = 1;
  // The last part is always a field, so a table never swallows it.
  while (at < parts.length - 1) {
    const children = childrenOf(object) ?? {};
    const relationship = Object.keys(children).find(
      (name) => name.toLowerCase() === parts[at].toLowerCase()
    );
    if (!relationship) break;
    table.push(relationship);
    object = children[relationship];
    at += 1;
  }
  return `${table.join('.')}$${parts.slice(at).join('.')}`;
}

/**
 * A custom report type's columns as its report file names them, read from
 * the type's own layout (readMetadata): each layout column is a table and a
 * field, and the file names it `table$field`. The describe names the same
 * column `table.field` — or, for a lookup offered as itself, with the
 * related record's name field after it (`Referral.Client__c.Name` for the
 * layout's `Client__c`), which no rule on the name alone can tell from a
 * field reached through that lookup, except by the related object's name
 * field: `nameFieldOf(table, field)` gives it for a layout lookup (`Name`
 * when it is not known; `CaseNumber` for a Case). A table joined down from
 * the base is a path (`Account.Referrals1__r`), and the describe may name
 * its columns by the object at the end of it instead (`Referral.Name`):
 * `objectOf(table)` gives that object, and each column is also matched by
 * it — unless two tables are the same object, when the object cannot say
 * which. Keyed by the describe's name; a name the layout does not explain
 * is left out.
 */
export function reportFileColumnsFromLayout(
  describeNames: readonly string[],
  layout: ReadonlyArray<{ table: string; field: string }>,
  nameFieldOf: (table: string, field: string) => string | undefined = () => undefined,
  objectOf: (table: string) => string | undefined = () => undefined
): Map<string, string> {
  // The names a table's columns may go by: its own, and its object's when
  // no other table is the same object.
  const tables = [...new Set(layout.map(({ table }) => table))];
  const tablesOfObject = new Map<string, number>();
  for (const table of tables) {
    const object = objectOf(table)?.toLowerCase();
    if (object) tablesOfObject.set(object, (tablesOfObject.get(object) ?? 0) + 1);
  }
  const prefixesOf = (table: string): string[] => {
    const object = objectOf(table);
    return object &&
      object.toLowerCase() !== table.toLowerCase() &&
      tablesOfObject.get(object.toLowerCase()) === 1
      ? [table, object]
      : [table];
  };
  const exact = new Map<string, string>();
  const asItself = new Map<string, string>();
  for (const { table, field } of layout) {
    for (const prefix of prefixesOf(table)) {
      exact.set(`${prefix}.${field}`.toLowerCase(), `${table}$${field}`);
      if (!field.includes('.')) {
        const nameField = nameFieldOf(table, field) ?? 'Name';
        asItself.set(`${prefix}.${field}.${nameField}`.toLowerCase(), `${table}$${field}`);
      }
    }
  }
  const names = new Map<string, string>();
  for (const name of describeNames) {
    const lower = name.toLowerCase();
    const direct = exact.get(lower);
    if (direct) {
      names.set(name, direct);
      continue;
    }
    // A lookup offered as itself: the describe adds its record's name field.
    const lookup = asItself.get(lower);
    if (lookup) names.set(name, lookup);
  }
  return names;
}

/** Whether a report type's API name is a custom report type's (`…__c`). */
export const isCustomReportType = (name: string): boolean => /__c$/i.test(name.trim());

// ——— changes to an existing report ———

const REPORT_LISTS = ['columns', 'groupingsDown', 'groupingsAcross'];

/**
 * A report read whole (readMetadata), with the repeated elements a change
 * touches always arrays — columns, groupings, and the filter's criteria —
 * so a change and its fingerprint do not depend on there being one.
 */
export function normalizeReport(metadata: Json): Json {
  const next = structuredClone(metadata);
  for (const key of REPORT_LISTS) {
    if (key in next) next[key] = list(next[key]).filter(isRecord);
  }
  if (isRecord(next.filter)) {
    next.filter = {
      ...next.filter,
      criteriaItems: list(next.filter.criteriaItems).filter(isRecord),
    };
  }
  return next;
}

/** A report's elements are in alphabetical order in the schema: a new one goes where it sorts. */
function setReportElement(metadata: Json, key: string, value: unknown): void {
  if (key in metadata) {
    metadata[key] = value;
    return;
  }
  const entries = Object.entries(metadata);
  const at = entries.findIndex(
    ([name]) => name !== 'fullName' && name.toLowerCase() > key.toLowerCase()
  );
  entries.splice(at < 0 ? entries.length : at, 0, [key, value]);
  for (const name of Object.keys(metadata)) delete metadata[name];
  for (const [name, entry] of entries) metadata[name] = entry;
}

type ReportFilter = ReportSpec['filters'][number];

const criteriaItem = (filter: ReportFilter): Json => ({
  column: filter.column,
  columnToColumn: false,
  isUnlocked: true,
  operator: filter.operator,
  value: filter.value,
});

const filterWords = (item: Json): string =>
  `${str(item.column)} ${str(item.operator)} ${str(item.value) || '(blank)'}`;

/** A relative range saved as a filter (`equals LAST_N_MONTHS:12`) on this column. */
const isRelativeRange = (item: Json, column: string): boolean =>
  str(item.column).toLowerCase() === column.toLowerCase() &&
  str(item.operator) === 'equals' &&
  relativeDateLiteral(str(item.value)) !== null;

function timeFrameWords(frame: Json): string {
  const interval = str(frame.interval);
  return interval === 'INTERVAL_CUSTOM'
    ? `${str(frame.dateColumn)}: ${str(frame.startDate) || '…'} to ${str(frame.endDate) || '…'}`
    : `${str(frame.dateColumn)}: ${interval.replace(/^INTERVAL_/, '').toLowerCase()}`;
}

const groupingWords = (grouping: Json): string =>
  `${str(grouping.field)}${str(grouping.dateGranularity) && str(grouping.dateGranularity) !== 'None' ? ` by ${str(grouping.dateGranularity)}` : ''}${str(grouping.sortOrder) === 'Desc' ? ' (descending)' : ''}`;

/**
 * A report as it is, in lines: what a change to it starts from. Filters are
 * numbered as its filter logic numbers them.
 */
export function reportLines(metadata: Json): string[] {
  const report = normalizeReport(metadata);
  const lines = [
    `Name: ${str(report.name)}`,
    ...(str(report.description) ? [`Description: ${str(report.description)}`] : []),
    `Report type: ${str(report.reportType)}`,
    `Format: ${str(report.format) || 'Tabular'}`,
    'Columns:',
    ...list(report.columns)
      .filter(isRecord)
      .map((column) => {
        const aggregates = list(column.aggregateTypes).map(str).filter(Boolean);
        return `  ${str(column.field)}${aggregates.length ? ` (${aggregates.join(', ')})` : ''}`;
      }),
  ];
  const down = list(report.groupingsDown).filter(isRecord);
  const across = list(report.groupingsAcross).filter(isRecord);
  if (down.length) lines.push(`Rows grouped by: ${down.map(groupingWords).join(', then ')}`);
  if (across.length) lines.push(`Columns grouped by: ${across.map(groupingWords).join(', then ')}`);
  const filter = isRecord(report.filter) ? report.filter : {};
  const items = list(filter.criteriaItems).filter(isRecord);
  if (items.length) {
    lines.push('Filters:', ...items.map((item, index) => `  ${index + 1}. ${filterWords(item)}`));
  }
  if (str(filter.booleanFilter)) lines.push(`Filter logic: ${str(filter.booleanFilter)}`);
  if (isRecord(report.timeFrameFilter)) {
    lines.push(`Date range: ${timeFrameWords(report.timeFrameFilter)}`);
  }
  if (str(report.scope)) lines.push(`Records: ${str(report.scope)}`);
  if (str(report.sortColumn)) {
    lines.push(`Sorted by: ${str(report.sortColumn)} ${str(report.sortOrder) || 'Asc'}`);
  }
  return lines;
}

export interface ReportEdit {
  name?: string;
  description?: string;
  /** A column to show; one already shown takes the summaries given. */
  addColumns?: ReadonlyArray<{ field: string; aggregates?: readonly string[] }>;
  removeColumns?: readonly string[];
  /** The report's filters, all of them: these replace the ones it has. */
  filters?: ReadonlyArray<{ column: string; operator: string; value: string }>;
  /** Filters added after the ones it has, ANDed with them. */
  addFilters?: ReadonlyArray<{ column: string; operator: string; value: string }>;
  filterLogic?: string;
  dateFilter?: {
    column: string;
    interval?: string;
    start?: string;
    end?: string;
    relative?: string;
  };
  format?: string;
  groupingsDown?: readonly unknown[];
  groupingsAcross?: readonly unknown[];
  scope?: string;
  sort?: { column: string; order?: string };
  showDetails?: boolean;
}

/**
 * A report changed, and its rows for the review page — or why not. A report
 * deploys whole, so everything the change does not name — its chart,
 * buckets, formulas, cross filters — stays exactly as read. `column` gives
 * a column's name as the report type has it, or null when it has none.
 *
 * A relative date range (`dateFilter.relative`) is a filter on the date
 * column, as in a new report: it takes the place of the report's time
 * frame, and of a relative range saved on that column before.
 */
export function editReport(
  metadata: Json,
  edit: ReportEdit,
  column: (name: string) => string | null = (name) => name
): { ok: true; metadata: Json; rows: ChangeRow[] } | { ok: false; errors: string[] } {
  const next = normalizeReport(metadata);
  const errors: string[] = [];
  const rows: ChangeRow[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const named = (name: string): string => {
    const found = column(name.trim());
    if (!found) errors.push(`${str(next.reportType)} has no column ${name}.`);
    return found ?? name.trim();
  };

  const name = edit.name?.trim();
  if (name !== undefined && name !== str(next.name)) {
    if (!name || name.length > 40) errors.push('A report name is 1 to 40 characters.');
    else {
      rows.push({ label: 'Name', value: `${str(next.name)} → ${name}` });
      setReportElement(next, 'name', name);
    }
  }
  const description = edit.description?.trim();
  if (description !== undefined && description !== str(next.description)) {
    if (description.length > 255) errors.push('A report description is 255 characters at most.');
    else {
      rows.push({ label: 'Description', value: description || '(none)' });
      setReportElement(next, 'description', description || null);
    }
  }

  // Columns: taken off, then added at the end.
  let columns = list(next.columns).filter(isRecord);
  const removed: string[] = [];
  for (const raw of edit.removeColumns ?? []) {
    const field = column(raw.trim()) ?? raw.trim();
    if (!columns.some((c) => same(str(c.field), field))) {
      errors.push(`${raw} is not a column of the report, so it cannot be taken off.`);
      continue;
    }
    columns = columns.filter((c) => !same(str(c.field), field));
    removed.push(field);
  }
  const shown: string[] = [];
  const summarized: string[] = [];
  for (const add of edit.addColumns ?? []) {
    const field = named(add.field);
    const aggregates: ReportSummary[] = [];
    for (const aggregate of add.aggregates ?? []) {
      const known = REPORT_SUMMARIES.find((s) => s === aggregate);
      if (known) aggregates.push(known);
      else errors.push(`${field}: a summary is one of ${REPORT_SUMMARIES.join(', ')}.`);
    }
    const words = aggregates.length ? `${field} (${aggregates.join(', ')})` : field;
    const at = columns.findIndex((c) => same(str(c.field), field));
    if (at < 0) {
      columns.push({ aggregateTypes: aggregates.length ? aggregates : null, field });
      shown.push(words);
    } else if (add.aggregates) {
      columns[at] = { aggregateTypes: aggregates.length ? aggregates : null, field };
      summarized.push(aggregates.length ? words : `${field} (no summary)`);
    } else {
      errors.push(`${field} is already a column of the report.`);
    }
  }
  if (removed.length) rows.push({ label: 'Columns taken off', value: removed.join(', ') });
  if (shown.length) rows.push({ label: 'Columns added', value: shown.join(', ') });
  if (summarized.length) rows.push({ label: 'Summaries', value: summarized.join(', ') });
  if (removed.length || shown.length || summarized.length) {
    if (columns.length === 0) errors.push('A report shows at least one column.');
    if (columns.length > 100) errors.push('A report shows 100 columns at most.');
    setReportElement(next, 'columns', columns);
  }

  // Filters, their logic and the date range.
  const filter: Json = isRecord(next.filter) ? { ...next.filter } : {};
  let items = list(filter.criteriaItems).filter(isRecord);
  let logic = str(filter.booleanFilter);
  let filtersChanged = false;
  const checkedFilters = (raw: ReportEdit['filters']): Json[] =>
    (raw ?? []).flatMap((entry) => {
      const operator = REPORT_FILTER_OPERATORS.find((o) => o === entry.operator);
      if (!operator) {
        errors.push(`A filter’s operator is one of ${REPORT_FILTER_OPERATORS.join(', ')}.`);
        return [];
      }
      return [criteriaItem({ column: named(entry.column), operator, value: entry.value })];
    });
  if (edit.filters) {
    items = checkedFilters(edit.filters);
    logic = '';
    filtersChanged = true;
    rows.push({
      label: 'Filters',
      value: items.length ? items.map(filterWords).join('; ') : 'none (the ones it had go)',
    });
  }
  if (edit.addFilters?.length) {
    const added = checkedFilters(edit.addFilters);
    if (logic) {
      logic = `(${logic})${added.map((_, index) => ` AND ${items.length + index + 1}`).join('')}`;
    }
    items = [...items, ...added];
    filtersChanged = true;
    rows.push({ label: 'Filters added', value: added.map(filterWords).join('; ') });
  }
  if (edit.dateFilter) {
    const range = edit.dateFilter;
    const dateColumn = named(range.column);
    const relativeText = str(range.relative);
    const start = str(range.start);
    const end = str(range.end);
    // A relative range saved on the column before gives way to the new range.
    const old = items.findIndex((item) => isRelativeRange(item, dateColumn));
    if (old >= 0 && !edit.filters) {
      const ours = new RegExp(`^\\((.*)\\) AND ${items.length}$`).exec(logic);
      if (logic && !(old === items.length - 1 && ours)) {
        errors.push(
          `The report’s filter logic (${logic}) uses its relative range on ${dateColumn} (filter ${old + 1}); give its filters whole, with filterLogic, to change it.`
        );
      } else {
        items = items.filter((_, index) => index !== old);
        logic = ours ? ours[1] : '';
        filtersChanged = true;
      }
    }
    if (relativeText) {
      const relative = relativeDateLiteral(relativeText);
      if (!relative) {
        errors.push(
          `"${relativeText}" is not a relative date range: LAST_N_DAYS:365, LAST_N_MONTHS:12, NEXT_N_WEEKS:4, THIS_YEAR, LAST_QUARTER…`
        );
      } else if (str(range.interval) || start || end) {
        errors.push('A date range is relative, an interval, or start and end dates: one of them.');
      } else {
        items = [
          ...items,
          criteriaItem({ column: dateColumn, operator: 'equals', value: relative }),
        ];
        if (logic) logic = `(${logic}) AND ${items.length}`;
        filtersChanged = true;
        if ('timeFrameFilter' in next) setReportElement(next, 'timeFrameFilter', null);
        rows.push({
          label: 'Date range',
          value: `${dateColumn}: ${relativeDateWords(relative)} (${relative}), counted from the day the report is run`,
        });
      }
    } else {
      const interval = DATE_INTERVALS.find((i) => i === (str(range.interval) || 'INTERVAL_CUSTOM'));
      if (!interval) errors.push(`A date range is one of ${DATE_INTERVALS.join(', ')}.`);
      if ((start && !ISO_DATE.test(start)) || (end && !ISO_DATE.test(end))) {
        errors.push('A date range’s start and end are YYYY-MM-DD.');
      }
      if (interval === 'INTERVAL_CUSTOM' && !start && !end) {
        errors.push('A custom date range has a start, an end, or both.');
      }
      if (interval) {
        const frame = {
          dateColumn,
          endDate: interval === 'INTERVAL_CUSTOM' && end ? end : null,
          interval,
          startDate: interval === 'INTERVAL_CUSTOM' && start ? start : null,
        };
        setReportElement(next, 'timeFrameFilter', frame);
        rows.push({ label: 'Date range', value: timeFrameWords(frame) });
      }
    }
  }
  const newLogic = edit.filterLogic?.trim();
  if (newLogic !== undefined && newLogic !== logic) {
    // Logic given with a relative range is over the other filters; the range is ANDed on.
    const relativeLast =
      edit.dateFilter?.relative && items.length > 0 && !errors.length ? items.length : 0;
    if (relativeLast && newLogic) {
      const problem = checkFilterLogic(newLogic, relativeLast - 1);
      if (problem) errors.push(problem);
      logic = `(${newLogic}) AND ${relativeLast}`;
    } else {
      logic = newLogic;
    }
    filtersChanged = true;
    rows.push({ label: 'Filter logic', value: logic || 'every filter (AND)' });
  }
  if (filtersChanged) {
    if (items.length > 20) errors.push('A report takes 20 filters at most.');
    if (logic) {
      const problem = checkFilterLogic(logic, items.length);
      if (problem && !errors.includes(problem)) errors.push(problem);
    }
    if (items.length === 0) {
      if ('filter' in next) setReportElement(next, 'filter', null);
    } else {
      // booleanFilter, criteriaItems, then whatever else it had (language).
      const { booleanFilter: _logic, criteriaItems: _items, ...rest } = filter;
      setReportElement(next, 'filter', {
        booleanFilter: logic || null,
        criteriaItems: items,
        ...rest,
      });
    }
  }

  // Format and groupings.
  const groupingErrors: string[] = [];
  const toGroupings = (raw: readonly unknown[], label: string): Json[] =>
    groupingsOf(raw, label, groupingErrors).map((g) => ({
      dateGranularity: g.dateGranularity ?? null,
      field: named(g.field),
      sortOrder: g.sortOrder,
    }));
  if (edit.groupingsDown) {
    const groupings = toGroupings(edit.groupingsDown, 'Row groupings');
    setReportElement(next, 'groupingsDown', groupings);
    rows.push({
      label: 'Rows grouped by',
      value: groupings.map(groupingWords).join(', then ') || 'nothing',
    });
  }
  if (edit.groupingsAcross) {
    const groupings = toGroupings(edit.groupingsAcross, 'Column groupings');
    setReportElement(next, 'groupingsAcross', groupings);
    rows.push({
      label: 'Columns grouped by',
      value: groupings.map(groupingWords).join(', then ') || 'nothing',
    });
  }
  errors.push(...groupingErrors);
  const formatText = edit.format?.trim();
  if (formatText !== undefined && formatText !== str(next.format)) {
    const format = REPORT_FORMATS.find((f) => f === formatText);
    if (!format) errors.push(`The format is one of ${REPORT_FORMATS.join(', ')}.`);
    else {
      rows.push({ label: 'Format', value: `${str(next.format) || 'Tabular'} → ${format}` });
      setReportElement(next, 'format', format);
    }
  }
  if (edit.groupingsDown || edit.groupingsAcross || formatText !== undefined) {
    const format = REPORT_FORMATS.find((f) => f === str(next.format));
    if (format) {
      errors.push(
        ...groupingProblems(
          format,
          list(next.groupingsDown).length,
          list(next.groupingsAcross).length
        )
      );
    }
  }

  const scope = edit.scope?.trim();
  if (scope && scope !== str(next.scope)) {
    rows.push({ label: 'Records', value: scope });
    setReportElement(next, 'scope', scope);
  }
  if (edit.sort) {
    const sortColumn = named(edit.sort.column);
    const order = edit.sort.order === 'Desc' ? 'Desc' : 'Asc';
    if (sortColumn !== str(next.sortColumn) || order !== str(next.sortOrder)) {
      rows.push({ label: 'Sorted by', value: `${sortColumn} ${order}` });
      setReportElement(next, 'sortColumn', sortColumn);
      setReportElement(next, 'sortOrder', order);
    }
  }
  if (
    edit.showDetails !== undefined &&
    edit.showDetails !== (String(next.showDetails) === 'true')
  ) {
    rows.push({ label: 'Detail rows', value: edit.showDetails ? 'shown' : 'hidden' });
    setReportElement(next, 'showDetails', edit.showDetails ? 'true' : 'false');
  }

  if (errors.length === 0 && rows.length === 0) errors.push('Nothing in that changes the report.');
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, metadata: next, rows };
}
