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

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  dateFilter?: { column: string; interval: DateInterval; start?: string; end?: string };
  scope?: string;
  sort?: { column: string; order: 'Asc' | 'Desc' };
  showDetails: boolean;
  /** The folder's developer name. */
  folder: string;
  /** Set when the folder is new and deploys with the report. */
  newFolder?: { label: string; access: FolderAccess };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (format === 'Tabular' && (groupingsDown.length > 0 || groupingsAcross.length > 0)) {
    errors.push(
      'A tabular report has no groupings; make it Summary (rows) or Matrix (rows and columns).'
    );
  }
  if (format === 'Summary') {
    if (groupingsDown.length === 0)
      errors.push('A summary report groups its rows by at least one field.');
    if (groupingsDown.length > 3) errors.push('A summary report groups by three fields at most.');
    if (groupingsAcross.length > 0) errors.push('Only a matrix report groups columns.');
  }
  if (format === 'Matrix') {
    if (groupingsDown.length === 0 || groupingsAcross.length === 0) {
      errors.push('A matrix report groups both rows and columns, by at least one field each.');
    }
    if (groupingsDown.length > 2 || groupingsAcross.length > 2) {
      errors.push('A matrix report groups by two fields at most each way.');
    }
  }
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
    if (!column) errors.push('A date range names its date column.');
    if (!interval) errors.push(`A date range is one of ${DATE_INTERVALS.join(', ')}.`);
    if ((start && !ISO_DATE.test(start)) || (end && !ISO_DATE.test(end))) {
      errors.push('A date range’s start and end are YYYY-MM-DD.');
    }
    if (interval === 'INTERVAL_CUSTOM' && !start && !end) {
      errors.push('A custom date range has a start, an end, or both.');
    }
    if (column && interval) {
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
  const report = metadataFile('Report', {
    columns: spec.columns.map((column) => ({
      aggregateTypes: column.aggregates.length > 0 ? column.aggregates : null,
      field: column.field,
    })),
    description: spec.description ?? null,
    filter:
      spec.filters.length > 0
        ? {
            booleanFilter: spec.filterLogic ?? null,
            criteriaItems: spec.filters.map((filter) => ({
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
    timeFrameFilter: spec.dateFilter
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

/**
 * A report type with columns added, and its rows for the review page — or
 * why not. A report type deploys whole, so everything it has stays exactly
 * as read: columns are only added, at the end of their section (a new
 * section at the end), never moved or taken away. A column already offered
 * anywhere in the type is refused, as is a table the type does not join.
 */
export function mergeReportTypeColumns(
  metadata: Json,
  adds: readonly ReportTypeColumnAdd[]
): { ok: true; metadata: Json; rows: ChangeRow[] } | { ok: false; errors: string[] } {
  const next = normalizeReportType(metadata);
  const sections = list(next.sections).filter(isRecord);
  const tables = reportTypeTables(next);
  const errors: string[] = [];
  const added = new Map<string, string[]>();
  const has = (table: string, field: string) =>
    sections.find((section) =>
      list(section.columns)
        .filter(isRecord)
        .some(
          (column) =>
            str(column.table).toLowerCase() === table.toLowerCase() &&
            str(column.field).toLowerCase() === field.toLowerCase()
        )
    );
  for (const add of adds) {
    const table = tables.find((t) => t.toLowerCase() === add.table.toLowerCase());
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
    const label = add.section.trim();
    if (!label || label.length > 80) {
      errors.push('A section label is 1 to 80 characters.');
      continue;
    }
    let section = sections.find((s) => str(s.masterLabel).toLowerCase() === label.toLowerCase());
    if (!section) {
      section = { columns: [], masterLabel: label };
      sections.push(section);
    }
    const columns = list(section.columns).filter(isRecord);
    columns.push({ checkedByDefault: add.checked ? 'true' : 'false', field: add.field, table });
    section.columns = columns;
    const key = str(section.masterLabel);
    added.set(key, [
      ...(added.get(key) ?? []),
      `${add.field}${add.checked ? ' (shown by default)' : ''}`,
    ]);
  }
  next.sections = sections;
  if (errors.length === 0 && added.size === 0)
    errors.push('Nothing in that changes the report type.');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    metadata: next,
    rows: [...added].map(([section, fields]) => ({
      label: `Section “${section}”`,
      value: `adds ${fields.join(', ')}`,
    })),
  };
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
