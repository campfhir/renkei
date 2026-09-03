/**
 * The `log_search` tool — self-scoped access to Renkei's own activity log,
 * the same store `apps/web/app/[slug]/logs` reads for the web Logs page.
 *
 * MCP callers authenticate with a bearer token, not a browser session, and
 * `renkei-operator`/`renkei-user` roles live only on the session cookie
 * (`apps/web/lib/session.ts`) — minted once at OIDC sign-in and never
 * carried onto an MCP token. So there is no role to check here, and every
 * caller gets exactly the web page's non-operator branch: their own
 * Jira-linked account's activity (`apps/web/app/[slug]/logs/actions.ts`),
 * never the tenant-wide view. That is also the safer default for a surface
 * whose output can reach a third-party model: log rows can carry
 * secure()-marked request/response bodies (failed-call payloads), and this
 * tool never renders those back, even when LOG_ENCRYPTION_KEY would let it
 * decrypt them — see ALLOWED_META below.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { LogRow } from '@campfhir/bored-logs';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { getDatabase } from '@renkei/db';
import { buildLogQueryOptions } from '@/lib/log-query';
import { resolveLogCipher } from '@/lib/log-encryption';
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

function formatRow(row: LogRow): string {
  const at = row.timestamp ? new Date(row.timestamp).toISOString() : 'unknown time';
  const extras = ALLOWED_META.map((key) => {
    const value = row.meta ? row.meta[key] : undefined;
    return value === undefined ? null : `${key}=${String(value)}`;
  })
    .filter((entry): entry is string => entry !== null)
    .join(' ');
  return `[${row.level}] ${at} — ${row.message}${extras ? `\n  ${extras}` : ''}`;
}

export function registerLogTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'log_search',
    {
      title: 'Logs · Read — Search your activity log',
      description:
        "Search Renkei's own activity log for entries about YOUR activity in this tenant — " +
        'API calls made on your behalf, request failures, and the like. Self-scoped to your ' +
        'own Jira-linked account, the same view a non-admin gets on the web Logs page — ' +
        'tenant-wide log access is an org-admin capability available only there. Supports ' +
        'the bored-logs filter syntax, e.g. "status:500" or "component:jira/fetch && ' +
        'level:error".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Filter expression, e.g. "level:error && component:jira/fetch"'),
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
      const accountId = context.accountId;
      if (!accountId) {
        return errText(
          'No Jira account linked yet — MCP log access is scoped to your own Jira-linked ' +
            'activity, the same as a non-admin sees on the Logs page. Connect Jira first.'
        );
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
      const query = typeof args.query === 'string' ? args.query : null;
      const start = typeof args.start === 'string' ? args.start : defaultStart();
      const end = typeof args.end === 'string' ? args.end : undefined;

      const adapter = new PostgresAdapter({
        db: dbResult.val,
        ...(cipher ? { encrypt: cipher.encrypt, decrypt: cipher.decrypt } : {}),
      });
      const result = await adapter.query(
        buildLogQueryOptions(query, context.tenantId, accountId, {
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
      if (rows.length === 0) {
        return textResult('No log entries match (searched your own activity only).');
      }

      const lines = [
        `${rows.length} log entr${rows.length === 1 ? 'y' : 'ies'} (your own activity only), newest first:`,
      ];
      for (const row of rows) lines.push('', formatRow(row));
      return textResult(lines.join('\n'));
    }
  );
}
