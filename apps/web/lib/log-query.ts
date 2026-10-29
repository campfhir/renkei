import {
  LOG_LEVELS,
  parseLogQueryExpr as parseBoredLogsExpr,
  type FilterExpr,
  type LogLevel,
  type LogQueryOptions,
} from '@campfhir/bored-logs';
import { createHash } from 'node:crypto';

/**
 * Keys that define a query's scope rather than narrowing it. A caller typing
 * `accountId:someone-else` is asking to read someone else's logs, so these are
 * stripped from whatever they typed and re-applied from the session.
 */
const RESTRICTED_KEYS = ['accountId', 'userId', 'subjectHash'];

/** Level names are the keys of the level-rank map, so membership is the check. */
const isKnownLevel = (level: string): level is LogLevel => level in LOG_LEVELS;

/**
 * Parse a query string to a FilterExpr tree, or null if it is empty or does not
 * parse. Handles `&&` / `||` and parenthesised grouping.
 *
 *   "level:error && tool:list_issues"
 *   "(level:error || level:warn) && tool:list_issues"
 */
export function parseLogQueryExpr(query: string): FilterExpr | null {
  if (!query || !query.trim()) return null;

  const result = parseBoredLogsExpr(query);
  return result.ok ? result.val : null;
}

/**
 * Whose lines a scoped caller may read: those tagged with their Jira account
 * (connector traffic), with their own subject (everything the app does on
 * their behalf: uploads, OCR, chats), or with their subject's hash (the
 * delegate, which never logs a subject in the clear). A bare string is an
 * account id.
 */
export interface LogOwner {
  accountId?: string | null;
  subject?: string | null;
}

/**
 * The delegate's stand-in for a subject: the first sixteen hex characters of
 * its SHA-256 (apps/worker-delegate/src/access-log.ts). Worked out here,
 * from the session, so the caller's own delegate lines are theirs too.
 */
export function subjectHash(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 16);
}

function ownerOf(owner: string | LogOwner | undefined): LogOwner {
  return typeof owner === 'string' ? { accountId: owner } : (owner ?? {});
}

/**
 * Build a filter tree with the caller's scope, when given, enforced:
 * `(whatever the caller asked for) && (accountId || subject || subjectHash)`.
 *
 * Accepts either a raw query string or an already-parsed tree, since the
 * `LogSearchBar` component hands back a tree directly.
 */
export function buildEnforcedLogQuery(
  userQuery: string | FilterExpr | null,
  owner?: string | LogOwner
): FilterExpr {
  const parsed = typeof userQuery === 'string' ? parseLogQueryExpr(userQuery) : userQuery;
  const scrubbed = parsed ? removeRestrictedFields(parsed, RESTRICTED_KEYS) : null;

  // Splice the caller's own AND-ed branches in rather than nesting their whole
  // tree, so the result stays in the parser's normal form.
  const userNodes = scrubbed ? (scrubbed.type === 'and' ? scrubbed.nodes : [scrubbed]) : [];
  const { accountId, subject } = ownerOf(owner);
  const leaves: FilterExpr[] = [
    ...(accountId
      ? [
          {
            type: 'filter' as const,
            filter: { key: 'accountId', operator: 'contains' as const, value: accountId },
          },
        ]
      : []),
    ...(subject
      ? [
          {
            type: 'filter' as const,
            filter: { key: 'subject', operator: '=' as const, value: subject },
          },
          {
            type: 'filter' as const,
            filter: { key: 'subjectHash', operator: '=' as const, value: subjectHash(subject) },
          },
        ]
      : []),
  ];
  const scope: FilterExpr[] = leaves.length ? [{ type: 'or', nodes: leaves }] : [];

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
 * query ran unscoped and returned the whole table.
 */
export function buildLogQueryOptions(
  userQuery: string | FilterExpr | null,
  owner?: string | LogOwner,
  window: LogQueryWindow = {}
): LogQueryOptions & { includeBinaryAttributes: boolean } {
  // Unknown names are dropped rather than passed through: the adapter rejects
  // the whole query on an unrecognised level.
  const levels = [...new Set((window.levels ?? []).filter(isKnownLevel))];

  return {
    attributeFilter: buildEnforcedLogQuery(userQuery, owner),
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
