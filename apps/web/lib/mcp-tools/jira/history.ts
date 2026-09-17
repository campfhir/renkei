/**
 * Issue history for Jira MCP: the changelog — every field change on an issue,
 * with when it happened and who made it. Comments and worklogs are not part
 * of the changelog; they have their own list tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, issueUrl, withPresentationHint } from '../common';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Jira pages the changelog at 100 entries; this many pages is the most one call reads. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
export const HISTORY_CEILING = PAGE_SIZE * MAX_PAGES;
const DEFAULT_MAX_RESULTS = 100;

/** One field's before/after value is capped so a description rewrite cannot swamp the list. */
const MAX_VALUE_CHARS = 200;

export interface HistoryChange {
  field: string;
  fieldId: string;
  from: string;
  to: string;
}

export interface HistoryEntry {
  id: string;
  /** ISO 8601 UTC, or Jira's own string when it could not be parsed. */
  at: string;
  /** Epoch millis for ordering and the since/until window; NaN when unparseable. */
  atMillis: number;
  author: string;
  changes: HistoryChange[];
}

function renderValue(item: Record<string, unknown>, key: 'from' | 'to'): string {
  // fromString/toString carry the human name (status "In Progress"); from/to
  // hold the id. Fall back to the id when a field has no display form.
  const value = text(item[`${key}String`]) || text(item[key]);
  if (!value) return '(none)';
  const flat = value.replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS)}…` : flat;
}

/** Who made the change: the author, else the automation/actor recorded in history metadata. */
function authorOf(entry: Record<string, unknown>): string {
  const author = isRecord(entry.author) ? entry.author : null;
  if (author) {
    const name = text(author.displayName) || text(author.name) || text(author.accountId);
    if (name) return name;
  }
  const metadata = isRecord(entry.historyMetadata) ? entry.historyMetadata : null;
  const actor = metadata && isRecord(metadata.actor) ? metadata.actor : null;
  if (actor) {
    const name = text(actor.displayName) || text(actor.id);
    if (name) return name;
  }
  if (metadata) {
    const generator = isRecord(metadata.generator) ? metadata.generator : null;
    const name = (generator && text(generator.displayName)) || text(metadata.type);
    if (name) return name;
  }
  return 'Unknown';
}

/** Normalize one raw changelog record into a HistoryEntry. */
export function parseHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!isRecord(raw)) return null;
  const created = text(raw.created);
  const millis = created ? Date.parse(created) : NaN;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const changes: HistoryChange[] = items.filter(isRecord).map((item) => ({
    field: text(item.field) || text(item.fieldId) || '(unknown field)',
    fieldId: text(item.fieldId),
    from: renderValue(item, 'from'),
    to: renderValue(item, 'to'),
  }));
  return {
    id: text(raw.id),
    at: Number.isNaN(millis) ? created || 'unknown time' : new Date(millis).toISOString(),
    atMillis: millis,
    author: authorOf(raw),
    changes,
  };
}

/** Case-insensitive match on a change's field name or id, so "status" and "customfield_10020" both work. */
function matchesField(change: HistoryChange, wanted: string): boolean {
  const needle = wanted.trim().toLowerCase();
  return change.field.toLowerCase() === needle || change.fieldId.toLowerCase() === needle;
}

export async function registerHistoryTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_get_issue_history
  server.registerTool(
    'jira_get_issue_history',
    {
      title: 'Jira · Read — Issue change history (who changed what, when)',
      description:
        'The change history of ONE issue: every field change — status transitions, assignee, ' +
        'priority, sprint, estimates, custom fields — with a timestamp and the person (or ' +
        'automation) who made it. Filter to one field to answer "when did this move to Done ' +
        'and who moved it?". Comments are not part of the history (jira_list_comments), nor ' +
        'are worklogs (jira_list_worklogs).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        field: z
          .string()
          .describe(
            'Only changes to this field, by name or id — e.g. "status", "assignee", ' +
              '"Sprint", "customfield_10020". Case-insensitive.'
          )
          .optional(),
        since: z
          .string()
          .describe('Only changes at or after this ISO date/time, e.g. 2026-09-01')
          .optional(),
        until: z
          .string()
          .describe('Only changes at or before this ISO date/time, e.g. 2026-09-15T17:00:00Z')
          .optional(),
        newestFirst: z
          .boolean()
          .describe('List the most recent change first (default: oldest first, as Jira does)')
          .optional(),
        maxResults: z
          .number()
          .describe(
            `Maximum changes returned (1-${HISTORY_CEILING}, default ${DEFAULT_MAX_RESULTS})`
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_get_issue_history invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const issueKey = typeof args.issueKey === 'string' ? args.issueKey.trim() : '';
        if (!issueKey) return errText('issueKey is required');

        const field = typeof args.field === 'string' && args.field.trim() ? args.field : null;
        const newestFirst = args.newestFirst === true;
        const maxResults = Math.max(
          1,
          Math.min(
            typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
              ? Math.floor(args.maxResults)
              : DEFAULT_MAX_RESULTS,
            HISTORY_CEILING
          )
        );

        const bound = (name: 'since' | 'until'): number | null => {
          const raw = typeof args[name] === 'string' ? args[name].trim() : '';
          if (!raw) return null;
          const millis = Date.parse(raw);
          if (Number.isNaN(millis)) {
            throw new Error(`${name} is not a date Jira can read: "${raw}". Use ISO 8601.`);
          }
          return millis;
        };
        const since = bound('since');
        const until = bound('until');

        // Jira serves the changelog oldest first, 100 per page, and the
        // newest N (or a date window) can only be known once every page is
        // in hand — so read them all, up to the ceiling, then filter.
        const entries: HistoryEntry[] = [];
        let total: number | null = null;
        let startAt = 0;
        let truncatedAtCeiling = false;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const query = new URLSearchParams({
            startAt: String(startAt),
            maxResults: String(PAGE_SIZE),
          });
          const response = await auth.fetch(
            granularJiraScopes('jira_get_issue_history', true),
            `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?${query.toString()}`
          );
          if (!response.ok) return errText(await describeJiraAuthFailure(response));

          const data: unknown = await response.json();
          const pageData = isRecord(data) ? data : {};
          const values = Array.isArray(pageData.values) ? pageData.values : [];
          for (const raw of values) {
            const entry = parseHistoryEntry(raw);
            if (entry) entries.push(entry);
          }
          if (typeof pageData.total === 'number') total = pageData.total;
          startAt += values.length;
          const isLast =
            pageData.isLast === true || values.length === 0 || (total !== null && startAt >= total);
          if (isLast) break;
          if (page === MAX_PAGES - 1) truncatedAtCeiling = true;
        }

        const inWindow = (entry: HistoryEntry): boolean => {
          if (since === null && until === null) return true;
          if (Number.isNaN(entry.atMillis)) return false;
          if (since !== null && entry.atMillis < since) return false;
          if (until !== null && entry.atMillis > until) return false;
          return true;
        };

        const filtered = entries
          .filter(inWindow)
          .map((entry) =>
            field
              ? { ...entry, changes: entry.changes.filter((c) => matchesField(c, field)) }
              : entry
          )
          .filter((entry) => entry.changes.length > 0);

        if (newestFirst) filtered.reverse();
        const shown = filtered.slice(0, maxResults);

        const scope = [
          field ? `to ${field}` : '',
          since !== null ? `since ${new Date(since).toISOString()}` : '',
          until !== null ? `until ${new Date(until).toISOString()}` : '',
        ]
          .filter(Boolean)
          .join(', ');

        const header =
          `${issueKey} has ${filtered.length} change${filtered.length === 1 ? '' : 's'}` +
          (scope ? ` ${scope}` : '') +
          (entries.length !== filtered.length ? ` (${entries.length} in the full history)` : '') +
          (shown.length < filtered.length
            ? `; showing the ${newestFirst ? 'newest' : 'oldest'} ${shown.length}`
            : '') +
          (filtered.length > 0 ? `, ${newestFirst ? 'newest' : 'oldest'} first:` : '.');

        const lines = [header];
        for (const entry of shown) {
          lines.push(`• ${entry.at} — ${entry.author}`);
          for (const change of entry.changes) {
            lines.push(`    ${change.field}: ${change.from} → ${change.to}`);
          }
        }
        if (truncatedAtCeiling) {
          lines.push(
            `… the history is longer than the ${HISTORY_CEILING} entries this tool reads; ` +
              `narrow with since/until or field.`
          );
        }
        lines.push(`Issue: ${issueUrl(context.siteUrl, issueKey)}`);

        if (shown.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a timeline table (When, Who, Field, From, To) usually scans faster than this ' +
                  'flat list.'
              ),
            },
          ],
        };
      } catch (error) {
        return errText(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
