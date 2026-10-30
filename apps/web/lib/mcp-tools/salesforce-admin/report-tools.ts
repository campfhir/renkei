/**
 * Report types and reports, built the way objects are: a proposal stores
 * the exact deployment — a custom report type (@renkei/connector-salesforce
 * report-metadata.ts buildReportTypePackage), or a report in a folder,
 * existing or new (buildReportPackage) — Salesforce validates it with a
 * check-only deploy, and the person applies it from the review page.
 *
 * The reads give what a proposal needs to name things right: the org's
 * report types and one type's columns (the Reports and Dashboards REST
 * API's `/analytics/reportTypes`), and its report folders. A report on a
 * new custom object needs its report type applied first.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildReportPackage,
  buildReportTypePackage,
  checkReportSpec,
  checkReportTypeSpec,
  DATE_GRANULARITIES,
  DATE_INTERVALS,
  FOLDER_ACCESS,
  isCustomReportType,
  REPORT_FILTER_OPERATORS,
  REPORT_FORMATS,
  REPORT_SUMMARIES,
  REPORT_TYPE_CATEGORIES,
  reportableFields,
  reportFileColumn,
  type ReportObjectInfo,
  type ReportSpec,
  type ReportTypeSpec,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import {
  errText,
  rec,
  recs,
  sfGet,
  str,
  textResult,
  type SalesforceAccess,
} from '../salesforce/client';
import { describeObject, resolveObject } from '../salesforce/schema';
import {
  isMissingReportType,
  listReportFolders,
  reportExists,
  reportTypeExists,
  REPORT_KIND,
  REPORT_TYPE_KIND,
  type ComponentView,
} from '@/lib/salesforce-admin/plan';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

const bullets = (errors: string[]) =>
  errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);

/** A report type's columns by section, from its describe: API name → label and type. */
interface ReportTypeDescribe {
  type: string;
  label: string;
  sections: Array<{
    label: string;
    columns: Array<{ name: string; label: string; dataType: string }>;
  }>;
  scopes: Array<{ value: string; label: string }>;
  defaultScope: string;
}

async function describeReportType(
  context: MCPToolContext,
  access: SalesforceAccess,
  type: string
): Promise<ReportTypeDescribe | string> {
  const answer = await sfGet(context, access, `/analytics/reportTypes/${encodeURIComponent(type)}`);
  if (!answer.ok) {
    return isMissingReportType(answer)
      ? `There is no report type ${type} (salesforce_admin_list_report_types lists them).`
      : answer.error;
  }
  const body = rec(answer.body);
  const metadata = rec(body.reportMetadata);
  const typeInfo = rec(metadata.reportType);
  const typeMetadata = rec(body.reportTypeMetadata);
  const scopeInfo = rec(typeMetadata.scopeInfo);
  return {
    type: str(typeInfo.type) || type,
    label: str(typeInfo.label) || type,
    sections: recs(typeMetadata.categories).map((category) => ({
      label: str(category.label),
      columns: Object.entries(rec(category.columns)).map(([name, column]) => ({
        name,
        label: str(rec(column).label),
        dataType: str(rec(column).dataType),
      })),
    })),
    scopes: recs(scopeInfo.values).map((v) => ({ value: str(v.value), label: str(v.label) })),
    defaultScope: str(scopeInfo.defaultValue),
  };
}

/**
 * A custom report type's columns as a report file names them, keyed by the
 * describe's name (reportFileColumn): the objects along each name are
 * described to tell a child relationship (part of the table) from a lookup
 * (part of the field).
 */
async function reportFileColumns(
  context: MCPToolContext,
  access: SalesforceAccess,
  described: ReportTypeDescribe
): Promise<Map<string, string>> {
  const children = new Map<string, Record<string, string> | undefined>();
  const load = async (object: string) => {
    if (children.has(object)) return children.get(object);
    const info = objectInfo(await describeObject(context, access, object));
    children.set(object, info?.children);
    return info?.children;
  };
  const names = new Map<string, string>();
  for (const column of described.sections.flatMap((section) => section.columns)) {
    const parts = column.name.split('.');
    let object = parts[0];
    for (let at = 1; at < parts.length - 1; at += 1) {
      const next = await load(object);
      const relationship = Object.keys(next ?? {}).find(
        (name) => name.toLowerCase() === parts[at].toLowerCase()
      );
      if (!relationship || !next) break;
      object = next[relationship];
    }
    if (parts.length > 2) await load(object);
    names.set(
      column.name,
      reportFileColumn(column.name, (name) => children.get(name))
    );
  }
  return names;
}

/** The describe as a report type proposal needs it. */
function objectInfo(describe: Awaited<ReturnType<typeof describeObject>>): ReportObjectInfo | null {
  if (typeof describe === 'string') return null;
  const { fields, nameField } = reportableFields(describe.fields);
  return {
    name: describe.name,
    labelPlural: describe.labelPlural || describe.label,
    fields,
    ...(nameField ? { nameField } : {}),
    lookups: describe.fields.flatMap((field) =>
      field.type === 'reference' && field.relationshipName ? [field.relationshipName] : []
    ),
    children: Object.fromEntries(
      (describe.childRelationships ?? []).flatMap((rel) =>
        rel.relationshipName ? [[rel.relationshipName, rel.childSObject]] : []
      )
    ),
  };
}

function reportTypeComponent(spec: ReportTypeSpec): ComponentView {
  return {
    type: 'ReportType',
    name: `${spec.developerName}__c`,
    action: 'create',
    rows: [
      { label: 'Label', value: spec.label },
      { label: 'Reports on', value: spec.baseObject },
      ...spec.joins.map((join, index) => ({
        label: index === 0 ? 'With' : 'Then with',
        value: `${join.relationship} (${join.object}) — ${join.outerJoin ? 'with or without them' : 'only with them'}`,
      })),
      { label: 'Category', value: spec.category },
      ...spec.sections.map((section) => ({
        label: `Section “${section.label}”`,
        value: `${section.columns.length} columns from ${section.table}${
          section.columns.some((c) => c.checked)
            ? `; shown by default: ${section.columns
                .filter((c) => c.checked)
                .map((c) => c.field)
                .join(', ')}`
            : ''
        }`,
      })),
      { label: 'Available to users', value: spec.deployed ? 'yes' : 'no (in development)' },
      { label: 'Description', value: spec.description },
    ],
  };
}

const groupingText = (g: ReportSpec['groupingsDown'][number]) =>
  `${g.field}${g.dateGranularity ? ` by ${g.dateGranularity}` : ''}${g.sortOrder === 'Desc' ? ' (descending)' : ''}`;

function reportComponents(spec: ReportSpec, folderLabel: string): ComponentView[] {
  const rows: ComponentView['rows'] = [
    { label: 'Name', value: spec.name },
    { label: 'Report type', value: spec.reportType },
    { label: 'Format', value: spec.format },
    {
      label: 'Columns',
      value: spec.columns
        .map((c) => (c.aggregates.length ? `${c.field} (${c.aggregates.join(', ')})` : c.field))
        .join(', '),
    },
  ];
  if (spec.groupingsDown.length)
    rows.push({
      label: 'Rows grouped by',
      value: spec.groupingsDown.map(groupingText).join(', then '),
    });
  if (spec.groupingsAcross.length)
    rows.push({
      label: 'Columns grouped by',
      value: spec.groupingsAcross.map(groupingText).join(', then '),
    });
  spec.filters.forEach((filter, index) =>
    rows.push({
      label: `Filter ${index + 1}`,
      value: `${filter.column} ${filter.operator} ${filter.value || '(blank)'}`,
    })
  );
  if (spec.filterLogic) rows.push({ label: 'Filter logic', value: spec.filterLogic });
  if (spec.dateFilter)
    rows.push({
      label: 'Date range',
      value:
        spec.dateFilter.interval === 'INTERVAL_CUSTOM'
          ? `${spec.dateFilter.column}: ${spec.dateFilter.start ?? '…'} to ${spec.dateFilter.end ?? '…'}`
          : `${spec.dateFilter.column}: ${spec.dateFilter.interval.replace(/^INTERVAL_/, '').toLowerCase()}`,
    });
  if (spec.scope) rows.push({ label: 'Records', value: spec.scope });
  if (spec.sort) rows.push({ label: 'Sorted by', value: `${spec.sort.column} ${spec.sort.order}` });
  if (spec.description) rows.push({ label: 'Description', value: spec.description });
  rows.push({ label: 'Folder', value: folderLabel });
  return [
    ...(spec.newFolder
      ? [
          {
            type: 'ReportFolder',
            name: spec.folder,
            action: 'create' as const,
            rows: [
              { label: 'Name', value: spec.newFolder.label },
              {
                label: 'Who sees it',
                value:
                  spec.newFolder.access === 'Hidden'
                    ? 'hidden from everyone but admins'
                    : spec.newFolder.access === 'ReadWrite'
                      ? 'everyone, who may also change its reports'
                      : 'everyone, read only',
              },
            ],
          },
        ]
      : []),
    { type: 'Report', name: `${spec.folder}/${spec.developerName}`, action: 'create', rows },
  ];
}

const groupingInput = z.object({
  field: z.string().min(1).describe('A column API name of the report type.'),
  sortOrder: z.enum(['Asc', 'Desc']).optional(),
  dateGranularity: z.enum(DATE_GRANULARITIES).optional().describe('For a date field.'),
});

export function registerAdminReportTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_list_report_types',
    {
      title: 'Salesforce Admin · Read — Report types',
      description:
        'The org’s report types, standard and custom, by category; or, given `type`, one report ' +
        'type’s columns by section with their API names and data types, and the record scopes ' +
        'it offers — the names a report’s columns, groupings and filters use. A custom report ' +
        'type’s API name ends in __c.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        type: z.string().optional().describe('A report type’s API name, to list its columns.'),
        search: z.string().optional().describe('Only types whose label or name contains this.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (args.type) {
        const described = await describeReportType(context, access, args.type.trim());
        if (typeof described === 'string') return errText(described);
        const custom = isCustomReportType(described.type);
        let shown = 0;
        const lines = [`${described.label} (${described.type})`];
        if (described.scopes.length > 0) {
          lines.push(
            `Records (scope): ${described.scopes.map((s) => `${s.value} — ${s.label}`).join('; ')}${described.defaultScope ? ` (default ${described.defaultScope})` : ''}`
          );
        }
        // A custom type's columns, named the way a report on it names them.
        const fileNames = custom ? await reportFileColumns(context, access, described) : null;
        if (custom) {
          lines.push(
            'Columns are listed as a report on this type names them (the table, a $, then the field or lookup path): use them as they are in salesforce_admin_propose_report.'
          );
        }
        for (const section of described.sections) {
          lines.push('', `${section.label}:`);
          for (const column of section.columns) {
            if (shown >= 500) break;
            lines.push(
              `  ${fileNames?.get(column.name) ?? column.name} — ${column.label} (${column.dataType})`
            );
            shown += 1;
          }
        }
        const total = described.sections.reduce((n, s) => n + s.columns.length, 0);
        if (total > shown) lines.push('', `${total - shown} more columns not shown.`);
        return textResult(lines.join('\n'));
      }
      const answer = await sfGet(context, access, '/analytics/reportTypes');
      if (!answer.ok) return errText(answer.error);
      const wanted = args.search?.trim().toLowerCase() ?? '';
      const lines: string[] = [];
      let count = 0;
      for (const category of Array.isArray(answer.body) ? answer.body.map(rec) : []) {
        const types = recs(category.reportTypes).filter(
          (t) =>
            !wanted ||
            str(t.label).toLowerCase().includes(wanted) ||
            str(t.type).toLowerCase().includes(wanted)
        );
        if (types.length === 0) continue;
        lines.push(`${str(category.label)}:`);
        for (const t of types) {
          if (count >= 200) break;
          lines.push(`  ${str(t.label)} — ${str(t.type)}`);
          count += 1;
        }
      }
      if (lines.length === 0)
        return textResult(wanted ? `No report type matches "${args.search}".` : 'No report types.');
      if (count >= 200) lines.push('', 'More not shown: narrow with search.');
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_admin_list_report_folders',
    {
      title: 'Salesforce Admin · Read — Report folders',
      description:
        'The org’s report folders the person can see: name, API name, and who sees them ' +
        '(Public, Hidden, or Shared with named people and groups). A proposed report goes in one ' +
        'of these, or in a new folder it creates.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const folders = await listReportFolders(context, access);
      if (typeof folders === 'string') return errText(folders);
      if (folders.length === 0) return textResult('No report folders yet.');
      return textResult(
        folders
          .map((f) => `${f.name} — ${f.developerName} (${f.accessType || 'unknown'})`)
          .join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_admin_propose_report_type',
    {
      title: 'Salesforce Admin · Act — Propose a report type',
      description:
        'Propose a new custom report type: the object it reports on, up to three child ' +
        'relationships joined down from it (each "only with them" or "with or without them"), ' +
        'and the sections of columns reports built on it can use — by default one section per ' +
        'object with every field, the name shown by default. Reports name it <apiName>__c. ' +
        'Checked by a validation deploy that changes nothing; the person reviews and applies it ' +
        'from the link this returns. Then propose reports on it with salesforce_admin_propose_report.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        label: z.string().min(1).max(50).describe('"Site Visits with Notes".'),
        apiName: z.string().optional().describe('Without __c; default from the label.'),
        description: z.string().max(255).optional().describe('Default the label.'),
        category: z
          .enum(REPORT_TYPE_CATEGORIES)
          .optional()
          .describe('Where it is listed when building a report (default other).'),
        baseObject: z.string().min(1).describe('The object it reports on: Site_Visit__c.'),
        joins: z
          .array(
            z.object({
              relationship: z
                .string()
                .min(1)
                .describe(
                  'A child relationship of the object before it (the base, then each join): Visit_Notes__r, Contacts.'
                ),
              outerJoin: z
                .boolean()
                .optional()
                .describe('true: records with or without these (default: only with them).'),
            })
          )
          .max(3)
          .optional(),
        sections: z
          .array(
            z.object({
              label: z.string().max(80).optional().describe('Default the object’s plural label.'),
              object: z.string().min(1).describe('The base object, or a join’s relationship name.'),
              fields: z
                .array(z.string())
                .optional()
                .describe(
                  'Field API names, or lookup paths like Owner.Email (default every field).'
                ),
              checked: z
                .array(z.string())
                .optional()
                .describe('Which of them a new report shows by default.'),
            })
          )
          .max(20)
          .optional(),
        deployed: z
          .boolean()
          .optional()
          .describe(
            'Available to report builders at once (default true); false keeps it in development.'
          ),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const base = await resolveObject(context, access, args.baseObject);
      if (typeof base === 'string') return errText(base);
      // Describe the objects down the join path, so the check can resolve them.
      const infos = new Map<string, ReportObjectInfo>();
      let current = objectInfo(base);
      if (current) infos.set(current.name.toLowerCase(), current);
      for (const join of args.joins ?? []) {
        if (!current) break;
        const relationship = Object.keys(current.children).find(
          (name) => name.toLowerCase() === join.relationship.trim().toLowerCase()
        );
        if (!relationship) break;
        const child = current.children[relationship];
        const described =
          infos.get(child.toLowerCase()) ??
          objectInfo(await describeObject(context, access, child));
        if (!described) break;
        infos.set(described.name.toLowerCase(), described);
        current = described;
      }
      const checked = checkReportTypeSpec({ ...args, baseObject: base.name }, (name) =>
        infos.get(name.toLowerCase())
      );
      if (!checked.ok) return bullets(checked.errors);
      const spec = checked.value;
      const exists = await reportTypeExists(context, access, spec.developerName);
      if (typeof exists === 'string') return errText(exists);
      if (exists)
        return errText(
          `Nothing was proposed: there is already a report type ${spec.developerName}__c.`
        );

      return proposeAndValidate(context, access, {
        kind: REPORT_TYPE_KIND,
        title: `New report type ${spec.label} (${spec.developerName}__c)`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          ...buildReportTypePackage(spec),
          components: [reportTypeComponent(spec)],
          preconditions: [{ kind: 'report-type-absent', name: spec.developerName }],
          dataSteps: [],
        },
        summary: [
          `• ${spec.developerName}__c — “${spec.label}”, on ${[spec.baseObject, ...spec.joins.map((j) => j.relationship)].join(' → ')}`,
          ...spec.sections.map((s) => `  ${s.label}: ${s.columns.length} columns`),
          'Once applied, reports can be built on it (salesforce_admin_propose_report, reportType ' +
            `${spec.developerName}__c).`,
        ],
      });
    }
  );

  server.registerTool(
    'salesforce_admin_propose_report',
    {
      title: 'Salesforce Admin · Act — Propose a report',
      description:
        'Propose a new report in a report folder — an existing one (salesforce_admin_list_report_folders) ' +
        'or a new one created with it: its report type, format (Tabular; Summary, grouped by up ' +
        'to three fields; Matrix, grouped by rows and columns), columns with their summaries ' +
        '(Sum, Average…), filters and filter logic, a date range, which records (scope), and ' +
        'sort. Column, grouping and filter names are the report type’s, as ' +
        'salesforce_admin_list_report_types lists them (on a custom report type: ' +
        'Object__c$Field__c). Checked by a validation deploy that changes nothing; the person ' +
        'reviews and applies it from the link this returns.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe('"Visits by Outcome this Quarter".'),
        apiName: z.string().optional().describe('Default from the name.'),
        description: z.string().max(255).optional(),
        reportType: z
          .string()
          .min(1)
          .describe('The report type’s API name: Opportunity, Site_Visits__c.'),
        format: z.enum(REPORT_FORMATS).optional().describe('Default Tabular.'),
        columns: z
          .array(
            z.object({
              field: z.string().min(1),
              aggregates: z
                .array(z.enum(REPORT_SUMMARIES))
                .optional()
                .describe('Summaries of a number, currency or percent column.'),
            })
          )
          .min(1)
          .max(100),
        groupingsDown: z
          .array(groupingInput)
          .max(3)
          .optional()
          .describe('Summary and Matrix: rows.'),
        groupingsAcross: z.array(groupingInput).max(2).optional().describe('Matrix only: columns.'),
        filters: z
          .array(
            z.object({
              column: z.string().min(1),
              operator: z.enum(REPORT_FILTER_OPERATORS),
              value: z
                .string()
                .describe(
                  'The value; several as a comma-separated list; dates YYYY-MM-DD or THIS_MONTH style.'
                ),
            })
          )
          .max(20)
          .optional(),
        filterLogic: z.string().optional().describe('Over filter numbers: "1 AND (2 OR 3)".'),
        dateFilter: z
          .object({
            column: z.string().min(1).describe('A date column of the report type.'),
            interval: z
              .enum(DATE_INTERVALS)
              .optional()
              .describe('Default INTERVAL_CUSTOM, with dates.'),
            start: z.string().optional().describe('YYYY-MM-DD, for INTERVAL_CUSTOM.'),
            end: z.string().optional().describe('YYYY-MM-DD, for INTERVAL_CUSTOM.'),
          })
          .optional(),
        scope: z
          .string()
          .optional()
          .describe(
            'Which records, as the report type offers (organization, user, MyAccounts…; salesforce_admin_list_report_types shows them).'
          ),
        sort: z
          .object({ column: z.string().min(1), order: z.enum(['Asc', 'Desc']).optional() })
          .optional(),
        showDetails: z
          .boolean()
          .optional()
          .describe('Detail rows under the groupings (default true).'),
        folder: z.string().optional().describe('An existing report folder, by name or API name.'),
        newFolder: z
          .object({
            label: z.string().min(1).max(40),
            apiName: z.string().optional(),
            access: z
              .enum(FOLDER_ACCESS)
              .optional()
              .describe('ReadOnly (default): everyone reads; ReadWrite: everyone edits; Hidden.'),
          })
          .optional()
          .describe('A new folder created with the report, in place of `folder`.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      if (Boolean(args.folder) === Boolean(args.newFolder)) {
        return errText(
          'Nothing was proposed: name an existing `folder` (salesforce_admin_list_report_folders) or a `newFolder`, one of the two.'
        );
      }

      let folderLabel: string;
      let folderRef: Parameters<typeof checkReportSpec>[1];
      if (args.folder) {
        const folders = await listReportFolders(context, access, args.folder.trim());
        if (typeof folders === 'string') return errText(folders);
        const folder = folders[0];
        if (!folder) {
          return errText(
            `Nothing was proposed: there is no report folder "${args.folder}" (salesforce_admin_list_report_folders lists them, or give newFolder).`
          );
        }
        folderLabel = folder.name;
        folderRef = { existing: folder.developerName };
      } else {
        const create = args.newFolder ?? { label: '' };
        folderLabel = `${create.label} (new)`;
        folderRef = {
          create: { label: create.label, developerName: create.apiName, access: create.access },
        };
      }
      const checked = checkReportSpec(args, folderRef);
      if (!checked.ok) return bullets(checked.errors);
      const spec = checked.value;

      const described = await describeReportType(context, access, spec.reportType);
      if (typeof described === 'string') return errText(`Nothing was proposed: ${described}`);
      spec.reportType = described.type;
      // Every column is checked against the report type's describe, so a
      // wrong name is refused here rather than by a failed validation in the
      // operators' queue. A standard type's describe names the columns as
      // the report file does; a custom type's are spelled differently in the
      // file (reportFileColumns), and either spelling is taken.
      {
        const known = new Map<string, string>();
        if (isCustomReportType(described.type)) {
          for (const [name, file] of await reportFileColumns(context, access, described)) {
            known.set(name.toLowerCase(), file);
            known.set(file.toLowerCase(), file);
          }
        } else {
          for (const column of described.sections.flatMap((section) => section.columns)) {
            known.set(column.name.toLowerCase(), column.name);
          }
        }
        const unknown: string[] = [];
        const fix = (name: string) => {
          const found = known.get(name.toLowerCase());
          if (!found) unknown.push(name);
          return found ?? name;
        };
        spec.columns = spec.columns.map((c) => ({ ...c, field: fix(c.field) }));
        spec.groupingsDown = spec.groupingsDown.map((g) => ({ ...g, field: fix(g.field) }));
        spec.groupingsAcross = spec.groupingsAcross.map((g) => ({ ...g, field: fix(g.field) }));
        spec.filters = spec.filters.map((f) => ({ ...f, column: fix(f.column) }));
        if (spec.dateFilter)
          spec.dateFilter = { ...spec.dateFilter, column: fix(spec.dateFilter.column) };
        if (spec.sort) spec.sort = { ...spec.sort, column: fix(spec.sort.column) };
        if (unknown.length > 0) {
          return bullets(
            [...new Set(unknown)].map(
              (name) =>
                `${described.type} has no column ${name} (salesforce_admin_list_report_types with type ${described.type} lists them).`
            )
          );
        }
      }

      const preconditions = spec.newFolder
        ? [
            { kind: 'report-folder-absent' as const, folder: spec.folder },
            { kind: 'report-absent' as const, folder: spec.folder, name: spec.developerName },
          ]
        : [{ kind: 'report-absent' as const, folder: spec.folder, name: spec.developerName }];
      if (spec.newFolder) {
        const clash = await listReportFolders(context, access, spec.folder);
        if (typeof clash === 'string') return errText(clash);
        if (clash.some((f) => f.developerName.toLowerCase() === spec.folder.toLowerCase())) {
          return errText(
            `Nothing was proposed: there is already a report folder ${spec.folder}; put the report in it with folder.`
          );
        }
      } else {
        const exists = await reportExists(context, access, spec.folder, spec.developerName);
        if (typeof exists === 'string') return errText(exists);
        if (exists) {
          return errText(
            `Nothing was proposed: ${folderLabel} already has a report ${spec.developerName}; give another name or apiName.`
          );
        }
      }

      return proposeAndValidate(context, access, {
        kind: REPORT_KIND,
        title: `New report ${spec.name} in ${spec.newFolder ? spec.newFolder.label : folderLabel}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          ...buildReportPackage(spec),
          components: reportComponents(spec, folderLabel),
          preconditions,
          dataSteps: [],
        },
        summary: [
          `• ${spec.folder}/${spec.developerName} — “${spec.name}”, ${spec.format.toLowerCase()} on ${spec.reportType}`,
          ...(spec.newFolder ? [`  in a new folder “${spec.newFolder.label}”`] : []),
          `  ${spec.columns.length} columns${spec.groupingsDown.length ? `, grouped by ${spec.groupingsDown.map((g) => g.field).join(', ')}` : ''}${spec.filters.length ? `, ${spec.filters.length} filters` : ''}`,
        ],
      });
    }
  );
}
