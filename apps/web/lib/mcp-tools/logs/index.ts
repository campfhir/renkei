/**
 * The `log_search` tool — access to Renkei's own activity log, the same
 * store `apps/web/app/[slug]/logs` reads for the web Logs page.
 *
 * An MCP bearer token now carries the caller's renkei roles (migration 091,
 * `context.roles`), captured from their browser session when the token was
 * issued — same source `apps/web/app/api/tenant/[tenantId]/logs/route.ts`
 * reads for the web page's own role branch. A caller with no roles on the
 * token (undefined/empty — a token issued before migration 091, or one that
 * never went through the browser authorize step, e.g. an 'agent' token) is
 * treated as holding none, the same fail-closed default `hasRole`
 * (`lib/session.ts`) uses: no ROLE_OPERATOR means the self-scoped branch,
 * never tenant-wide.
 *
 * `renkei-operator` gets the same tenant-wide search the web page's operator
 * branch does — every account's activity, not just their own, and no Jira
 * grant of their own is required to ask for it. Everyone else gets exactly
 * the web page's non-operator branch: their own Jira-linked account's
 * activity (`apps/web/app/[slug]/logs/actions.ts`). That remains the safer
 * default for a surface whose output can reach a third-party model: log
 * rows can carry secure()-marked request/response bodies (failed-call
 * payloads), and this tool never renders those back for either branch, even
 * when LOG_ENCRYPTION_KEY would let it decrypt them — see ALLOWED_META below.
 *
 * Two ways in for filtering, both optional and ANDed together when both are
 * given:
 *  - `filter` — a structured condition tree (FILTER_OPS below), converted
 *    to bored-logs' own `FilterExpr`/`LogQueryToken` shape by `toFilterExpr`.
 *    This is the one to reach for whenever there is real AND/OR structure —
 *    it is validated by its own Zod schema (recursively, via z.lazy — the
 *    resulting JSON Schema round-trips through the SDK's tools/list
 *    conversion fine, unlike the raw string grammar a model has to get
 *    exactly right on the first try).
 *  - `query` — the bored-logs string grammar itself (`key:'value'`, `&&`,
 *    `||`, `()`), parsed with the PACKAGE's own `parseLogQueryExpr` (not the
 *    lossy wrapper in `@/lib/log-query`, which silently drops a malformed
 *    query rather than reporting it — fine for a human editing a search box
 *    live, wrong for a model that needs to know *why* zero rows came back).
 *
 * Both compile down to the same `FilterExpr` tree `buildLogQueryOptions`
 * already accepts, and `buildEnforcedLogQuery`'s restricted-key scrubbing
 * (tenantId/accountId/userId) applies to it exactly the same way regardless
 * of which surface produced it — a structured `filter: {key: "accountId", ...}`
 * is stripped exactly like a string `accountId:'x'` would be.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  parseLogQueryExpr,
  type FilterExpr,
  type LogQueryToken,
  type LogRow,
} from '@campfhir/bored-logs';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { getDatabase } from '@renkei/db';
import { buildLogQueryOptions } from '@/lib/log-query';
import { resolveLogCipher } from '@/lib/log-encryption';
import { ROLE_OPERATOR } from '@/lib/access';
import type { MCPToolContext } from '../common';

/** The connector key the logs capability registers under. */
export const LOGS_CONNECTOR = 'logs';

const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error', 'critical'] as const;
/** Mirrors the web Logs page's own default (apps/web/app/[slug]/logs/window.ts). */
const DEFAULT_LEVELS = ['warn', 'error', 'critical'];
const DEFAULT_WINDOW_DAYS = 7;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * Meta keys ever rendered back to the model — an allowlist, not a blocklist,
 * so a new attribute some future call site starts logging is excluded by
 * default rather than surfacing until someone notices. Deliberately excludes
 * `requestBody`/`responseBody`/`tokenClaims` (the secure()-marked payloads
 * the web viewer decrypts for a human operator) and the scoping keys
 * themselves (`tenantId`/`accountId`/`subject`/`displayName`), which are
 * already implied by "this is your own activity."
 */
const ALLOWED_META = ['component', 'tool', 'url', 'method', 'status', 'reason', 'action'];

/**
 * Added on top of ALLOWED_META for the operator (tenant-wide) branch only.
 * The exclusion reasoning above stops applying once a result can span every
 * account in the tenant — without these, an operator could not tell whose
 * activity a given row was.
 */
const OPERATOR_EXTRA_META = ['subject', 'accountId', 'displayName'];

/** The operators `filter` leaves accept — see FILTER_OP_HELP for what each does. */
const FILTER_OPS = [
  'contains',
  'notContains',
  'eq',
  'notEq',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
] as const;
type FilterOp = (typeof FILTER_OPS)[number];

const FILTER_OP_HELP =
  'contains/notContains: substring match. eq/notEq: exact match. gt/gte/lt/lte: numeric or ' +
  "chronological comparison (by the value's shape). isNull/isNotNull: the attribute is, or " +
  'is not, the null literal.';

interface FilterLeaf {
  key: string;
  op: FilterOp;
  value?: string | number | boolean;
}
/** A structured condition tree — a leaf, or an all-of/any-of group of nodes. */
type FilterNode = FilterLeaf | { and: FilterNode[] } | { or: FilterNode[] };

const filterLeafSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .describe(
        'Attribute name: a plain key like "status" or "component", or a dotted/bracketed ' +
          'path like "session.id" or "items[*].sku".'
      ),
    op: z.enum(FILTER_OPS).describe(FILTER_OP_HELP),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .describe('Required for every op except isNull/isNotNull, which must omit it.'),
  })
  .refine(
    (leaf) =>
      leaf.op === 'isNull' || leaf.op === 'isNotNull'
        ? leaf.value === undefined
        : leaf.value !== undefined,
    { message: 'value is required for every op except isNull/isNotNull, which must omit it.' }
  );

const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    filterLeafSchema,
    z.object({ and: z.array(filterNodeSchema).min(1) }).describe('Every one of these must match.'),
    z
      .object({ or: z.array(filterNodeSchema).min(1) })
      .describe('At least one of these must match.'),
  ])
);

const QUERY_SYNTAX_HELP =
  'Filter-string grammar (for one or two quick conditions — prefer "filter" once there is real ' +
  'AND/OR structure to get right):\n' +
  '  key:\'value\'    substring match (key:"value" also works)\n' +
  "  key:='value'   exact match          key:!='value'   not equal\n" +
  "  key:>'value'   greater than         key:>='value'   greater or equal\n" +
  "  key:<'value'   less than            key:<='value'   less or equal\n" +
  "  key:!'value'   does NOT contain\n" +
  "  bare text      matches the message, same as message:'text'\n" +
  '  combine with a space or && (AND), || (OR — binds tighter than AND), and ( ) grouping\n' +
  '  e.g. "status:>=\'500\' && component:\'jira/fetch\'" or "level:error || level:critical"';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - DEFAULT_WINDOW_DAYS);
  return d.toISOString();
}

function formatRow(row: LogRow, isOperator: boolean): string {
  const at = row.timestamp ? new Date(row.timestamp).toISOString() : 'unknown time';
  const allowedKeys = isOperator ? [...ALLOWED_META, ...OPERATOR_EXTRA_META] : ALLOWED_META;
  const extras = allowedKeys
    .map((key) => {
      const value = row.meta ? row.meta[key] : undefined;
      return value === undefined ? null : `${key}=${String(value)}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join(' ');
  return `[${row.level}] ${at} — ${row.message}${extras ? `\n  ${extras}` : ''}`;
}

/** One structured leaf → the LogQueryToken bored-logs' query engine reads. */
function tokenForLeaf(leaf: FilterLeaf): LogQueryToken {
  const value = leaf.value === undefined ? '' : String(leaf.value);
  switch (leaf.op) {
    case 'contains':
      return { key: leaf.key, operator: 'contains', value };
    case 'notContains':
      return { key: leaf.key, operator: 'contains', value, negated: true };
    case 'eq':
      return { key: leaf.key, operator: '=', value };
    case 'notEq':
      return { key: leaf.key, operator: '=', value, negated: true };
    case 'gt':
      return { key: leaf.key, operator: '>', value };
    case 'gte':
      return { key: leaf.key, operator: '>=', value };
    case 'lt':
      return { key: leaf.key, operator: '<', value };
    case 'lte':
      return { key: leaf.key, operator: '<=', value };
    case 'isNull':
      return { key: leaf.key, operator: '=', value: 'null', nullValue: true };
    case 'isNotNull':
      return { key: leaf.key, operator: '=', value: 'null', nullValue: true, negated: true };
  }
}

/** A structured `filter` tree → bored-logs' own FilterExpr shape. */
function toFilterExpr(node: FilterNode): FilterExpr {
  if ('and' in node) return { type: 'and', nodes: node.and.map(toFilterExpr) };
  if ('or' in node) return { type: 'or', nodes: node.or.map(toFilterExpr) };
  return { type: 'filter', filter: tokenForLeaf(node) };
}

/** AND every given tree together, dropping the ones that are absent. */
function combineExprs(...exprs: Array<FilterExpr | null>): FilterExpr | null {
  const present = exprs.filter((expr): expr is FilterExpr => expr !== null);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return { type: 'and', nodes: present };
}

export function registerLogTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'log_search',
    {
      title: 'Logs · Read — Search your activity log',
      description:
        "Search Renkei's own activity log for entries about API calls, request failures, and " +
        'the like. Self-scoped to YOUR OWN Jira-linked account by default, the same view a ' +
        'non-admin gets on the web Logs page. Callers holding the renkei-operator role get ' +
        "the web page's operator view instead — every account's activity across the tenant, " +
        'no Jira grant of your own required.\n\n' +
        'Filter with "filter" (structured, recommended for AND/OR), "query" (a short string ' +
        'grammar), or both — they combine with AND. ' +
        QUERY_SYNTAX_HELP,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        filter: filterNodeSchema
          .optional()
          .describe(
            'A structured condition tree. Example: {"and":[{"key":"status","op":"gte",' +
              '"value":500},{"key":"component","op":"eq","value":"jira/fetch"}]}'
          ),
        query: z
          .string()
          .optional()
          .describe('A filter-string expression — see the tool description for the grammar.'),
        levels: z
          .array(z.enum(LOG_LEVEL_VALUES))
          .optional()
          .describe('Only these levels (default: warn, error, critical)'),
        start: z
          .string()
          .optional()
          .describe(`ISO-8601 lower bound (default: last ${DEFAULT_WINDOW_DAYS} days)`),
        end: z.string().optional().describe('ISO-8601 upper bound (default: now)'),
        sort: z.enum(['asc', 'desc']).optional().describe('Default desc (newest first)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) {
        return errText('This caller has no recorded identity, so it has no activity to look up.');
      }

      // Undefined/empty roles fail closed to the non-operator branch — see
      // the module comment above for what can leave roles unset.
      const isOperator = (context.roles ?? []).includes(ROLE_OPERATOR);

      // Operators search the whole tenant, so they need no Jira account of
      // their own; everyone else stays scoped to the account backing their
      // own Jira grant, same as the web page's non-admin branch.
      let accountId: string | undefined;
      if (!isOperator) {
        accountId = context.accountId;
        if (!accountId) {
          return errText(
            'No Jira account linked yet — MCP log access is scoped to your own Jira-linked ' +
              'activity, the same as a non-admin sees on the Logs page. Connect Jira first.'
          );
        }
      }

      // Re-validated with the same schema the SDK already ran, rather than
      // asserted: gives back a properly-typed FilterNode with no `as` cast,
      // and stays correct if a future caller of registerLogTools skips SDK
      // validation (the test suite does exactly that).
      let filterExpr: FilterExpr | null = null;
      if (args.filter !== undefined) {
        const parsedFilter = filterNodeSchema.safeParse(args.filter);
        if (!parsedFilter.success) {
          return errText(
            `Invalid "filter": ${parsedFilter.error.issues[0]?.message ?? 'malformed filter tree'}`
          );
        }
        filterExpr = toFilterExpr(parsedFilter.data);
      }

      let queryExpr: FilterExpr | null = null;
      if (typeof args.query === 'string' && args.query.trim()) {
        const parsedQuery = parseLogQueryExpr(args.query);
        if (!parsedQuery.ok) {
          return errText(
            `Could not parse "query": ${parsedQuery.err.toString()}\n\n${QUERY_SYNTAX_HELP}`
          );
        }
        queryExpr = parsedQuery.val;
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const cipherResult = resolveLogCipher();
      const cipher = cipherResult.state === 'on' ? cipherResult.cipher : undefined;

      const requestedLevels = Array.isArray(args.levels)
        ? args.levels.filter((level): level is string => typeof level === 'string')
        : [];
      const levels = requestedLevels.length > 0 ? requestedLevels : DEFAULT_LEVELS;
      const limit =
        typeof args.limit === 'number'
          ? Math.min(Math.max(Math.trunc(args.limit), 1), MAX_LIMIT)
          : DEFAULT_LIMIT;
      const sort = args.sort === 'asc' ? 'asc' : 'desc';
      const start = typeof args.start === 'string' ? args.start : defaultStart();
      const end = typeof args.end === 'string' ? args.end : undefined;

      const adapter = new PostgresAdapter({
        db: dbResult.val,
        ...(cipher ? { encrypt: cipher.encrypt, decrypt: cipher.decrypt } : {}),
      });
      const result = await adapter.query(
        buildLogQueryOptions(combineExprs(filterExpr, queryExpr), context.tenantId, accountId, {
          levels,
          start,
          end,
          sort,
          limit,
        })
      );
      if (!result.ok) {
        return errText(`Failed to query logs: ${result.err.message || 'unknown error'}`);
      }

      const rows = result.val;
      const scopeLabel = isOperator ? 'tenant-wide' : 'your own activity only';
      if (rows.length === 0) {
        return textResult(`No log entries match (${scopeLabel}).`);
      }

      const lines = [
        `${rows.length} log entr${rows.length === 1 ? 'y' : 'ies'} (${scopeLabel}), newest first:`,
      ];
      for (const row of rows) lines.push('', formatRow(row, isOperator));
      return textResult(lines.join('\n'));
    }
  );
}
