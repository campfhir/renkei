/**
 * A report run, shaped for telling its story: what was run (name, filters,
 * date range — so no number is quoted without what it counts), the
 * groupings as readable rows with their subtotals, the grand total, detail
 * rows on request, and whether Salesforce truncated anything.
 *
 * The run answer's `factMap` is keyed by grouping position — `T!T` the
 * grand total, `0!T` the first first-level row grouping, `0_1!T` its second
 * child, `<down>!<across>` a matrix cell (Reports and Dashboards REST API,
 * "Decode the Fact Map"). This turns those keys back into labels.
 */

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value);
}

export interface ReportGroupRow {
  /** Row grouping labels, outermost first. */
  down: string[];
  /** Column grouping labels (matrix reports only). */
  across?: string[];
  /** Aggregate label → formatted value ("Sum of Amount" → "$1,200.00"). */
  values: Record<string, string>;
}

export interface ShapedReportRun {
  reportId: string;
  name: string;
  format: string;
  /** The filters as applied, in words. */
  filters: string[];
  filterLogic: string | null;
  dateFilter: string | null;
  aggregates: string[];
  total: Record<string, string>;
  groups: ReportGroupRow[];
  /** Detail rows when asked for; column label → formatted value. */
  detailColumns?: string[];
  details?: Array<Record<string, string>>;
  /** Salesforce returned every row (false = its row limit truncated the run). */
  allData: boolean;
  /** Groups or detail rows this shaping left out to stay within `maxRows`. */
  omittedRows: number;
}

export function shapeReportRun(
  answer: unknown,
  options: { maxRows?: number } = {}
): ShapedReportRun {
  const maxRows = options.maxRows ?? 200;
  const root = record(answer);
  const attributes = record(root.attributes);
  const metadata = record(root.reportMetadata);
  const extended = record(root.reportExtendedMetadata);
  const factMap = record(root.factMap);

  const aggregateKeys = list(metadata.aggregates).map(text);
  const aggregateInfo = record(extended.aggregateColumnInfo);
  const aggregateLabels = aggregateKeys.map(
    (key) => text(record(aggregateInfo[key]).label) || (key === 'RowCount' ? 'Record Count' : key)
  );
  const detailInfo = record(extended.detailColumnInfo);
  const columnLabel = (column: string): string => text(record(detailInfo[column]).label) || column;

  const valuesOf = (factKey: string): Record<string, string> => {
    const fact = record(factMap[factKey]);
    const values: Record<string, string> = {};
    list(fact.aggregates).forEach((aggregate, index) => {
      values[aggregateLabels[index] ?? `#${index + 1}`] = text(record(aggregate).label);
    });
    return values;
  };

  const groupingsDown = list(record(root.groupingsDown).groupings);
  const groupingsAcross = list(record(root.groupingsAcross).groupings);

  // Every row grouping node, depth-first, with its label path.
  const downNodes: Array<{ key: string; labels: string[] }> = [];
  const walk = (nodes: unknown[], labels: string[], into: typeof downNodes): void => {
    for (const node of nodes) {
      const entry = record(node);
      const path = [...labels, text(entry.label)];
      into.push({ key: text(entry.key), labels: path });
      walk(list(entry.groupings), path, into);
    }
  };
  walk(groupingsDown, [], downNodes);
  const acrossNodes: Array<{ key: string; labels: string[] }> = [];
  walk(groupingsAcross, [], acrossNodes);

  const groups: ReportGroupRow[] = [];
  if (acrossNodes.length > 0) {
    for (const down of [{ key: 'T', labels: ['Total'] }, ...downNodes]) {
      for (const across of acrossNodes) {
        const factKey = `${down.key}!${across.key}`;
        if (factKey in factMap) {
          groups.push({ down: down.labels, across: across.labels, values: valuesOf(factKey) });
        }
      }
    }
  } else {
    for (const down of downNodes) {
      const factKey = `${down.key}!T`;
      if (factKey in factMap) groups.push({ down: down.labels, values: valuesOf(factKey) });
    }
  }

  const shaped: ShapedReportRun = {
    reportId: text(attributes.reportId) || text(metadata.id),
    name: text(attributes.reportName) || text(metadata.name),
    format: text(metadata.reportFormat),
    filters: list(metadata.reportFilters).map((filter) => {
      const entry = record(filter);
      return `${text(entry.column)} ${text(entry.operator)} ${text(entry.value)}`.trim();
    }),
    filterLogic: text(metadata.reportBooleanFilter) || null,
    dateFilter: describeDateFilter(record(metadata.standardDateFilter)),
    aggregates: aggregateLabels,
    total: valuesOf('T!T'),
    groups: groups.slice(0, maxRows),
    allData: root.allData !== false,
    omittedRows: Math.max(0, groups.length - maxRows),
  };

  const detailColumns = list(metadata.detailColumns).map(text);
  const detailRows: Array<Record<string, string>> = [];
  for (const [key, fact] of Object.entries(factMap)) {
    // Detail rows hang off the innermost groupings (or T!T for a tabular report).
    if (groupingsDown.length > 0 && key === 'T!T') continue;
    for (const row of list(record(fact).rows)) {
      const cells = list(record(row).dataCells);
      const out: Record<string, string> = {};
      detailColumns.forEach((column, index) => {
        out[columnLabel(column)] = text(record(cells[index]).label);
      });
      detailRows.push(out);
    }
  }
  if (detailRows.length > 0) {
    shaped.detailColumns = detailColumns.map(columnLabel);
    shaped.details = detailRows.slice(0, maxRows);
    shaped.omittedRows += Math.max(0, detailRows.length - maxRows);
  }
  return shaped;
}

function describeDateFilter(filter: Json): string | null {
  const column = text(filter.column);
  if (!column) return null;
  const duration = text(filter.durationValue);
  if (duration && duration !== 'CUSTOM')
    return `${column}: ${duration.replace(/_/g, ' ').toLowerCase()}`;
  const start = text(filter.startDate);
  const end = text(filter.endDate);
  if (!start && !end) return `${column}: all time`;
  return `${column}: ${start || '…'} to ${end || '…'}`;
}

/** The run's status from an async instance answer (`New`, `Running`, `Success`, `Error`). */
export function instanceStatus(answer: unknown): string {
  const root = record(answer);
  return text(record(root.attributes).status) || text(root.status);
}
