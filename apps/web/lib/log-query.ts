import {
  LOG_LEVELS,
  parseLogQueryExpr as parseBoredLogsExpr,
  type FilterExpr,
  type LogLevel,
  type LogQueryOptions,
} from '@campfhir/bored-logs';

/**
 * Keys that define a query's scope rather than narrowing it. A caller typing
 * `tenantId:other-tenant` is asking to read someone else's logs, so these are
 * stripped from whatever they typed and re-applied from the session.
 */
const RESTRICTED_KEYS = ['tenantId', 'accountId', 'userId'];

/** Level names are the keys of the level-rank map, so membership is the check. */
const isKnownLevel = (level: string): level is LogLevel => level in LOG_LEVELS;

/**
 * Parse a query string to a FilterExpr tree, or null if it is empty or does not
 * parse. Handles `&&` / `||` and parenthesised grouping.
 *
 *   "level:error && tool:list_issues"
 *   "(level:error || level:warn) && tenantId:abc123"
 */
export function parseLogQueryExpr(query: string): FilterExpr | null {
  if (!query || !query.trim()) return null;

  const result = parseBoredLogsExpr(query);
  return result.ok ? result.val : null;
}

/** A single comparison, wrapped in the or-node form the parser emits. */
function scopeLeaf(key: string, value: string): FilterExpr {
  return {
    type: 'or',
    nodes: [{ type: 'filter', filter: { key, operator: 'contains', value } }],
  };
}

/**
 * Build a filter tree with the tenant — and, when given, the Jira account —
 * enforced: `(whatever the caller asked for) && tenantId && accountId`.
 *
 * Enforcing the tenant is also what keeps the viewer readable. Records written
 * outside a tenant's request path (schema migration, adapter registration at
 * boot) carry no `tenantId` attribute, so scoping to one excludes them instead
 * of mixing deployment noise into a tenant's activity.
 *
 * Accepts either a raw query string or an already-parsed tree, since the
 * `LogSearchBar` component hands back a tree directly.
 */
export function buildEnforcedLogQuery(
  userQuery: string | FilterExpr | null,
  tenantId: string,
  accountId?: string
): FilterExpr {
  const parsed = typeof userQuery === 'string' ? parseLogQueryExpr(userQuery) : userQuery;
  const scrubbed = parsed ? removeRestrictedFields(parsed, RESTRICTED_KEYS) : null;

  // Splice the caller's own AND-ed branches in rather than nesting their whole
  // tree, so the result stays in the parser's normal form.
  const userNodes = scrubbed ? (scrubbed.type === 'and' ? scrubbed.nodes : [scrubbed]) : [];
  const scope = [scopeLeaf('tenantId', tenantId)];
  if (accountId) scope.push(scopeLeaf('accountId', accountId));

  return { type: 'and', nodes: [...userNodes, ...scope] };
}

/**
 * Remove restricted keys from a filter tree, collapsing any node left empty or
 * with a single child.
 */
function removeRestrictedFields(tree: FilterExpr, restrictedKeys: string[]): FilterExpr | null {
  if (tree.type === 'filter') {
    return restrictedKeys.includes(tree.filter.key) ? null : tree;
  }

  const nodes = tree.nodes
    .map((node) => removeRestrictedFields(node, restrictedKeys))
    .filter((node): node is FilterExpr => node !== null);

  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  return { type: tree.type, nodes };
}

/** Everything the viewer can vary beyond the query itself. */
export interface LogQueryWindow {
  /** From `LogLevelFilter`. Level is a column, so it has its own option. */
  levels?: string[];
  /** ISO-8601 bounds from `LogDateRangePicker`. Omitting both is last 24h. */
  start?: string | null;
  end?: string | null;
  sort?: 'asc' | 'desc';
  limit?: number;
}

/**
 * Build the options for `adapter.query()`, with the caller's scope enforced.
 *
 * The tree goes in `attributeFilter` — the option the adapter actually reads.
 * It was previously passed as `filter`, which the adapter ignores, so every
 * query ran unscoped and returned the whole table: one tenant's operator saw
 * other tenants' activity plus the gateway's own boot and migration records.
 */
export function buildLogQueryOptions(
  userQuery: string | FilterExpr | null,
  tenantId: string,
  accountId?: string,
  window: LogQueryWindow = {}
): LogQueryOptions & { includeBinaryAttributes: boolean } {
  // Unknown names are dropped rather than passed through: the adapter rejects
  // the whole query on an unrecognised level.
  const levels = [...new Set((window.levels ?? []).filter(isKnownLevel))];

  return {
    attributeFilter: buildEnforcedLogQuery(userQuery, tenantId, accountId),
    levels: levels.length ? levels : undefined,
    start: window.start ?? undefined,
    end: window.end ?? undefined,
    sort: window.sort ?? 'desc',
    limit: window.limit ?? 1000,
    // Attribute values past ~2KB live in log_attr_blob; without this the
    // adapter never fetches them and the attribute silently vanishes from
    // the viewer (which is how the failure request/response bodies went
    // missing).
    includeBinaryAttributes: true,
  };
}
