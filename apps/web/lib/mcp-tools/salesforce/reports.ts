/**
 * The salesforce_ report and dashboard tools: find, describe and run the
 * reports the person can see — synchronously, or in the background for a
 * heavy one — and read dashboards. Read-only: building and sharing reports
 * is the admin connector's (docs/salesforce-connectors-design.md).
 *
 * A run's answer is shaped for telling its story (shapeReportRun in
 * @renkei/connector-salesforce): what was run first — name, filters as
 * applied, date range, when — then the groupings with their subtotals, the
 * total, and whether Salesforce truncated anything. A comparison ("this
 * quarter against last") is the same report run twice with a different
 * filter for that run only; nothing is saved.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  instanceStatus,
  isSalesforceId,
  shapeReportRun,
  soqlContains,
  soqlString,
  to18,
  type ShapedReportRun,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from './salesforce-auth';
import {
  errText,
  json,
  readAccess,
  rec,
  recordUrl,
  recs,
  sfGet,
  sfQuery,
  sfRequest,
  str,
  textResult,
  type SalesforceAccess,
} from './client';
import { limitField } from './fields';

const reportField = z
  .string()
  .min(1)
  .describe('The report: its id, or its exact name (salesforce_find_reports finds it).');

const dashboardField = z
  .string()
  .min(1)
  .describe('The dashboard: its id, or its exact title (salesforce_find_dashboards finds it).');

const filterField = z.object({
  column: z
    .string()
    .min(1)
    .describe('The column API name, as salesforce_describe_report lists it.'),
  operator: z
    .enum([
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
    ])
    .describe('How to compare.'),
  value: z.string().describe('The value; several for equals as a comma-separated list.'),
});

const runChanges = {
  addFilters: z
    .array(filterField)
    .max(10)
    .optional()
    .describe('Filters added for this run only (nothing is saved) — "West region only".'),
  dateRange: z
    .object({
      column: z
        .string()
        .optional()
        .describe('The date column; default the report’s own date filter column.'),
      duration: z
        .string()
        .optional()
        .describe(
          'A relative range: THIS_QUARTER, LAST_QUARTER, THIS_FISCAL_YEAR, LAST_N_DAYS:90 style names as the report’s describe offers.'
        ),
      start: z.string().optional().describe('YYYY-MM-DD, for a custom range.'),
      end: z.string().optional().describe('YYYY-MM-DD, for a custom range.'),
    })
    .optional()
    .describe(
      'The date range for this run only — run twice with different ranges to compare periods.'
    ),
  includeDetails: z
    .boolean()
    .optional()
    .describe(
      'Detail rows too (default: groupings and totals only). Synchronous runs return at most 2,000.'
    ),
};

async function resolveReport(
  context: MCPToolContext,
  access: SalesforceAccess,
  ref: string
): Promise<{ id: string; name: string } | string> {
  const input = ref.trim();
  if (isSalesforceId(input)) return { id: to18(input), name: input };
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, FolderName FROM Report WHERE Name = ${soqlString(input)} LIMIT 6`
  );
  if (!found.ok) return found.error;
  if (found.records.length === 1)
    return { id: str(found.records[0].Id), name: str(found.records[0].Name) };
  if (found.records.length > 1) {
    return [
      `More than one report is named "${input}":`,
      ...found.records.map(
        (r) => `  • ${str(r.Id)} — in ${str(r.FolderName) || 'a private folder'}`
      ),
      'Say which one by id.',
    ].join('\n');
  }
  return `No report named "${input}" is visible to you; salesforce_find_reports searches by part of the name.`;
}

/** The report's metadata with this run's changes applied, or null when there are none. */
async function runMetadata(
  context: MCPToolContext,
  access: SalesforceAccess,
  reportId: string,
  changes: {
    addFilters?: z.infer<typeof filterField>[];
    dateRange?: { column?: string; duration?: string; start?: string; end?: string };
  }
): Promise<{ metadata: Record<string, unknown>; variation: string[] } | null | string> {
  if (!changes.addFilters?.length && !changes.dateRange) return null;
  const described = await sfGet(
    context,
    access,
    `/analytics/reports/${encodeURIComponent(reportId)}/describe`
  );
  if (!described.ok) return described.error;
  const metadata = rec(rec(described.body).reportMetadata);
  const variation: string[] = [];
  if (changes.addFilters?.length) {
    metadata.reportFilters = [...recs(metadata.reportFilters), ...changes.addFilters];
    const logic = str(metadata.reportBooleanFilter);
    if (logic) {
      // Existing filter logic numbers the filters; the new ones are ANDed on.
      const before = recs(metadata.reportFilters).length - changes.addFilters.length;
      const added = changes.addFilters.map((_, index) => String(before + index + 1));
      metadata.reportBooleanFilter = `(${logic}) AND ${added.join(' AND ')}`;
    }
    variation.push(
      ...changes.addFilters.map((f) => `added filter ${f.column} ${f.operator} ${f.value}`)
    );
  }
  if (changes.dateRange) {
    const current = rec(metadata.standardDateFilter);
    const column = changes.dateRange.column ?? str(current.column);
    if (!column) return 'This report has no date filter; name the date column in dateRange.column.';
    metadata.standardDateFilter = changes.dateRange.duration
      ? { column, durationValue: changes.dateRange.duration, startDate: null, endDate: null }
      : {
          column,
          durationValue: 'CUSTOM',
          startDate: changes.dateRange.start ?? null,
          endDate: changes.dateRange.end ?? null,
        };
    variation.push(
      `date range ${column} ${changes.dateRange.duration ?? `${changes.dateRange.start ?? '…'} to ${changes.dateRange.end ?? '…'}`}`
    );
  }
  return { metadata, variation };
}

/** A shaped run, as the lines a model tells a story from. */
export function runLines(
  shaped: ShapedReportRun,
  extras: { variation?: string[]; ranAt?: string; url?: string }
): string {
  const lines = [
    `Report: ${shaped.name}${shaped.format ? ` (${shaped.format.toLowerCase()})` : ''}${extras.url ? ` — ${extras.url}` : ''}`,
    `Ran: ${extras.ranAt ?? new Date().toISOString()}`,
    `Filters: ${shaped.filters.length ? shaped.filters.join('; ') : 'none'}${shaped.filterLogic ? ` (logic ${shaped.filterLogic})` : ''}`,
    `Date range: ${shaped.dateFilter ?? 'none'}`,
    ...(extras.variation?.length
      ? [`For this run only: ${extras.variation.join('; ')} (nothing saved)`]
      : []),
    `Total: ${
      Object.entries(shaped.total)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
  ];
  if (shaped.groups.length > 0) {
    lines.push('Groups:');
    for (const group of shaped.groups) {
      const where = [
        group.down.join(' › '),
        ...(group.across ? [group.across.join(' › ')] : []),
      ].join(' × ');
      lines.push(
        `  ${where}: ${Object.entries(group.values)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`
      );
    }
  }
  if (shaped.details) {
    lines.push(`Detail rows (${shaped.details.length}):`, json(shaped.details));
  }
  if (!shaped.allData) {
    lines.push(
      'Salesforce truncated this run (row limit): the totals cover what it returned. Run it async for everything.'
    );
  }
  if (shaped.omittedRows > 0) lines.push(`${shaped.omittedRows} more rows not shown.`);
  return lines.join('\n');
}

async function resolveDashboard(
  context: MCPToolContext,
  access: SalesforceAccess,
  ref: string
): Promise<{ id: string; name: string } | string> {
  const input = ref.trim();
  if (isSalesforceId(input)) return { id: to18(input), name: input };
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Title, FolderName FROM Dashboard WHERE Title = ${soqlString(input)} LIMIT 6`
  );
  if (!found.ok) return found.error;
  if (found.records.length === 1)
    return { id: str(found.records[0].Id), name: str(found.records[0].Title) };
  if (found.records.length > 1) {
    return [
      `More than one dashboard is titled "${input}":`,
      ...found.records.map(
        (r) => `  • ${str(r.Id)} — in ${str(r.FolderName) || 'a private folder'}`
      ),
      'Say which one by id.',
    ].join('\n');
  }
  return `No dashboard titled "${input}" is visible to you.`;
}

export function registerReportTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_find_reports',
    {
      title: 'Salesforce · Read — Find reports',
      description:
        'Reports the person can see, by part of their name, folder or report type, most recently ' +
        'run first — or `recent` for the ones they viewed lately.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z.string().optional().describe('Part of the report’s name.'),
        folder: z.string().optional().describe('Part of the folder’s name.'),
        recent: z.boolean().optional().describe('The person’s recently viewed reports instead.'),
        limit: limitField(100, 25),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      if (args.recent) {
        const result = await sfGet(context, access, '/analytics/reports');
        if (!result.ok) return errText(result.error);
        const rows = recs(result.body).slice(0, args.limit ?? 25);
        return textResult(
          rows.length
            ? rows.map((r) => `${str(r.id)} — ${str(r.name)}`).join('\n')
            : 'No recently viewed reports.'
        );
      }
      const where = [
        ...(args.search ? [`Name LIKE ${soqlContains(args.search)}`] : []),
        ...(args.folder ? [`FolderName LIKE ${soqlContains(args.folder)}`] : []),
      ];
      const page = await sfQuery(
        context,
        access,
        `SELECT Id, Name, FolderName, Format, Description, LastRunDate FROM Report${
          where.length ? ` WHERE ${where.join(' AND ')}` : ''
        } ORDER BY LastRunDate DESC NULLS LAST LIMIT ${args.limit ?? 25}`
      );
      if (!page.ok) return errText(page.error);
      if (page.records.length === 0) return textResult('No reports match.');
      return textResult(
        page.records
          .map(
            (r) =>
              `${str(r.Id)} — ${str(r.Name)} (${str(r.Format).toLowerCase() || 'report'}, in ${str(r.FolderName) || 'a private folder'})` +
              (str(r.LastRunDate) ? `, last run ${str(r.LastRunDate).slice(0, 10)}` : '') +
              (str(r.Description) ? `\n    ${str(r.Description)}` : '')
          )
          .join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_describe_report',
    {
      title: 'Salesforce · Read — What a report measures',
      description:
        'A report’s type, format, groupings, aggregates (what each number is), columns and ' +
        'filters — read it before quoting a number from the report, and for the column names a ' +
        'run-time filter needs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ report: reportField }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const report = await resolveReport(context, access, args.report);
      if (typeof report === 'string') return errText(report);
      const result = await sfGet(
        context,
        access,
        `/analytics/reports/${encodeURIComponent(report.id)}/describe`
      );
      if (!result.ok) return errText(result.error);
      const body = rec(result.body);
      const metadata = rec(body.reportMetadata);
      const extended = rec(body.reportExtendedMetadata);
      const typeMeta = rec(body.reportTypeMetadata);
      const aggregateInfo = rec(extended.aggregateColumnInfo);
      const detailInfo = rec(extended.detailColumnInfo);
      const groupingInfo = rec(extended.groupingColumnInfo);
      const label = (info: Record<string, unknown>, key: string) =>
        str(rec(info[key]).label) || key;
      return textResult(
        json({
          id: report.id,
          name: str(metadata.name),
          format: str(metadata.reportFormat),
          reportType: str(rec(metadata.reportType).label) || str(rec(metadata.reportType).type),
          groupingsDown: recs(metadata.groupingsDown).map((g) => ({
            column: str(g.name),
            label: label(groupingInfo, str(g.name)),
            granularity: str(g.dateGranularity) || undefined,
          })),
          groupingsAcross: recs(metadata.groupingsAcross).map((g) => ({
            column: str(g.name),
            label: label(groupingInfo, str(g.name)),
          })),
          aggregates: strings(metadata.aggregates).map((key) => ({
            key,
            label: label(aggregateInfo, key),
          })),
          columns: strings(metadata.detailColumns).map((key) => ({
            column: key,
            label: label(detailInfo, key),
          })),
          filters: recs(metadata.reportFilters).map(
            (f) => `${str(f.column)} ${str(f.operator)} ${str(f.value)}`
          ),
          filterLogic: str(metadata.reportBooleanFilter) || undefined,
          dateFilter: rec(metadata.standardDateFilter),
          dateDurations: recs(typeMeta.standardDateFilterDurationGroups)
            .flatMap((group) => recs(group.standardDateFilterDurations).map((d) => str(d.value)))
            .slice(0, 40),
          url: recordUrl(access, report.id),
        })
      );
    }
  );

  server.registerTool(
    'salesforce_run_report',
    {
      title: 'Salesforce · Read — Run a report',
      description:
        'Run a report now and read its result: what was run (filters, date range), its groupings ' +
        'with subtotals, and the total — the outline of the story the numbers tell. Change ' +
        'filters or the date range for this run only (nothing is saved): run it twice to compare ' +
        'periods or regions. Ask for detail rows to explain a surprising subtotal. For a slow or ' +
        'very large report use salesforce_run_report_async.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ report: reportField, ...runChanges }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const report = await resolveReport(context, access, args.report);
      if (typeof report === 'string') return errText(report);
      const changed = await runMetadata(context, access, report.id, args);
      if (typeof changed === 'string') return errText(changed);
      const path = `/analytics/reports/${encodeURIComponent(report.id)}?includeDetails=${args.includeDetails ? 'true' : 'false'}`;
      const result = changed
        ? await sfRequest(context, access, 'POST', path, { reportMetadata: changed.metadata })
        : await sfGet(context, access, path);
      if (!result.ok) {
        return errText(
          result.status === 504 || /timed out|timeout/i.test(result.error)
            ? `${result.error}\nThis report is slow; run it with salesforce_run_report_async.`
            : result.error
        );
      }
      return textResult(
        runLines(shapeReportRun(result.body), {
          variation: changed?.variation,
          url: recordUrl(access, report.id),
        })
      );
    }
  );

  server.registerTool(
    'salesforce_run_report_async',
    {
      title: 'Salesforce · Read — Run a report in the background',
      description:
        'Start a report run in the background — for a slow report or a full set of detail rows ' +
        '— and get its instance id; read it with salesforce_get_report_results. Salesforce keeps ' +
        'results for 24 hours; a recent finished run of the same report without changes is ' +
        'reused rather than started again (report runs are limited per hour).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ report: reportField, ...runChanges }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const report = await resolveReport(context, access, args.report);
      if (typeof report === 'string') return errText(report);
      const changed = await runMetadata(context, access, report.id, args);
      if (typeof changed === 'string') return errText(changed);
      if (!changed) {
        const recent = await sfGet(
          context,
          access,
          `/analytics/reports/${encodeURIComponent(report.id)}/instances`
        );
        if (recent.ok) {
          const fresh = recs(recent.body).find(
            (instance) =>
              str(instance.status) === 'Success' &&
              Date.now() - Date.parse(str(instance.completionDate) || str(instance.requestDate)) <
                15 * 60_000 &&
              instance.hasDetailRows === Boolean(args.includeDetails)
          );
          if (fresh) {
            return textResult(
              `A run finished at ${str(fresh.completionDate)} is reused: instance ${str(fresh.id)}. Read it with salesforce_get_report_results.`
            );
          }
        }
      }
      const result = await sfRequest(
        context,
        access,
        'POST',
        `/analytics/reports/${encodeURIComponent(report.id)}/instances?includeDetails=${args.includeDetails ? 'true' : 'false'}`,
        changed ? { reportMetadata: changed.metadata } : undefined
      );
      if (!result.ok) return errText(result.error);
      const instance = rec(result.body);
      return textResult(
        `Started: instance ${str(instance.id)} (${str(instance.status) || 'New'})` +
          (changed?.variation.length
            ? `, for this run only: ${changed.variation.join('; ')}`
            : '') +
          '. Read it with salesforce_get_report_results in a moment.'
      );
    }
  );

  server.registerTool(
    'salesforce_get_report_results',
    {
      title: 'Salesforce · Read — Read a background report run',
      description:
        'The status of a background run, and its result once finished — shaped like ' +
        'salesforce_run_report’s. Without an instance id, lists the report’s recent runs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        report: reportField,
        instanceId: z.string().optional().describe('The instance a background run returned.'),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const report = await resolveReport(context, access, args.report);
      if (typeof report === 'string') return errText(report);
      if (!args.instanceId) {
        const list = await sfGet(
          context,
          access,
          `/analytics/reports/${encodeURIComponent(report.id)}/instances`
        );
        if (!list.ok) return errText(list.error);
        const rows = recs(list.body);
        return textResult(
          rows.length
            ? rows
                .map(
                  (i) =>
                    `${str(i.id)} — ${str(i.status)}, requested ${str(i.requestDate)}${str(i.completionDate) ? `, done ${str(i.completionDate)}` : ''}`
                )
                .join('\n')
            : 'No background runs of this report in the last 24 hours.'
        );
      }
      if (!/^[a-zA-Z0-9]{15,18}$/.test(args.instanceId))
        return errText('That is not an instance id.');
      const result = await sfGet(
        context,
        access,
        `/analytics/reports/${encodeURIComponent(report.id)}/instances/${encodeURIComponent(args.instanceId)}`
      );
      if (!result.ok) return errText(result.error);
      const status = instanceStatus(result.body);
      if (status !== 'Success') {
        return textResult(
          status === 'Error'
            ? `The run failed in Salesforce: ${str(rec(rec(result.body).attributes).errorMessage) || 'no reason given'}.`
            : `Still ${status || 'running'}; try again in a moment.`
        );
      }
      const attributes = rec(rec(result.body).attributes);
      return textResult(
        runLines(shapeReportRun(result.body), {
          ranAt: str(attributes.completionDate) || undefined,
          url: recordUrl(access, report.id),
        })
      );
    }
  );

  server.registerTool(
    'salesforce_find_dashboards',
    {
      title: 'Salesforce · Read — Find dashboards',
      description: 'Dashboards the person can see, by part of their title or folder — or `recent`.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z.string().optional(),
        folder: z.string().optional(),
        recent: z.boolean().optional(),
        limit: limitField(100, 25),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      if (args.recent) {
        const result = await sfGet(context, access, '/analytics/dashboards');
        if (!result.ok) return errText(result.error);
        const rows = recs(result.body).slice(0, args.limit ?? 25);
        return textResult(
          rows.length
            ? rows.map((r) => `${str(r.id)} — ${str(r.name)}`).join('\n')
            : 'No recently viewed dashboards.'
        );
      }
      const where = [
        ...(args.search ? [`Title LIKE ${soqlContains(args.search)}`] : []),
        ...(args.folder ? [`FolderName LIKE ${soqlContains(args.folder)}`] : []),
      ];
      const page = await sfQuery(
        context,
        access,
        `SELECT Id, Title, FolderName, Description FROM Dashboard${
          where.length ? ` WHERE ${where.join(' AND ')}` : ''
        } ORDER BY Title LIMIT ${args.limit ?? 25}`
      );
      if (!page.ok) return errText(page.error);
      if (page.records.length === 0) return textResult('No dashboards match.');
      return textResult(
        page.records
          .map(
            (r) => `${str(r.Id)} — ${str(r.Title)} (in ${str(r.FolderName) || 'a private folder'})`
          )
          .join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_get_dashboard',
    {
      title: 'Salesforce · Read — Read a dashboard',
      description:
        'A dashboard’s components with their latest values — each with the report behind it, so ' +
        'a number can be traced to its report (and explained with salesforce_run_report) — who it ' +
        'runs as, its filters, and when it was last refreshed.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ dashboard: dashboardField }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const dashboard = await resolveDashboard(context, access, args.dashboard);
      if (typeof dashboard === 'string') return errText(dashboard);
      const result = await sfGet(
        context,
        access,
        `/analytics/dashboards/${encodeURIComponent(dashboard.id)}`
      );
      if (!result.ok) return errText(result.error);
      const body = rec(result.body);
      const metadata = rec(body.dashboardMetadata);
      const components = recs(metadata.components);
      const data = recs(body.componentData);
      const lines = [
        `Dashboard: ${str(metadata.name) || dashboard.name} — ${recordUrl(access, dashboard.id)}`,
        `Runs as: ${str(rec(metadata.runningUser).displayName) || 'the viewer'}`,
        ...(recs(metadata.filters).length
          ? [
              `Filters: ${recs(metadata.filters)
                .map((f) => str(f.name))
                .join(', ')}`,
            ]
          : []),
      ];
      for (const component of components) {
        const own = data.find((entry) => str(entry.componentId) === str(component.id));
        const title = str(component.header) || str(component.title) || 'Component';
        const reportId = str(component.reportId);
        lines.push(`\n▸ ${title}${reportId ? ` (report ${reportId})` : ''}`);
        const status = rec(own?.status);
        if (str(status.dataStatus) && str(status.dataStatus) !== 'DATA') {
          lines.push(`  ${str(status.dataStatus).toLowerCase()}`);
          continue;
        }
        const shaped = shapeReportRun(rec(own?.reportResult), { maxRows: 25 });
        const total = Object.entries(shaped.total)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ');
        if (total) lines.push(`  Total: ${total}`);
        for (const group of shaped.groups) {
          lines.push(
            `  ${group.down.join(' › ')}${group.across ? ` × ${group.across.join(' › ')}` : ''}: ${Object.values(group.values).join(', ')}`
          );
        }
        if (str(status.refreshDate)) lines.push(`  Refreshed ${str(status.refreshDate)}`);
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_refresh_dashboard',
    {
      title: 'Salesforce · Read — Refresh a dashboard',
      description:
        'Ask Salesforce to re-run a dashboard’s reports, then read it with salesforce_get_dashboard. ' +
        'Salesforce limits how often a dashboard can refresh; when it refuses, its last refresh is said.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ dashboard: dashboardField }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const dashboard = await resolveDashboard(context, access, args.dashboard);
      if (typeof dashboard === 'string') return errText(dashboard);
      const result = await sfRequest(
        context,
        access,
        'PUT',
        `/analytics/dashboards/${encodeURIComponent(dashboard.id)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult(
        `Refreshing ${dashboard.name}; read it with salesforce_get_dashboard in a moment.`
      );
    }
  );
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
