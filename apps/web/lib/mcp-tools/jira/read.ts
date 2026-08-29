/**
 * Read-only tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { cacheUserDisplayName, getCachedDisplayName, withPresentationHint } from '../common';
import { STANDARD_ISSUE_FIELDS, normalizeFieldId, renderFieldValue } from './fields';
import { previewToolMeta, RESULTS_LIST_URI } from '../widgets';
import { logger } from '@/lib/logger';
import { issueLinkTargets, issueLinksMarkdown } from './issue-urls';
import { checkJql, describeJqlProblem, JQL_PARAMETER_DESCRIPTION } from './jql';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';
import { sprintProgress, sprintWindow } from './sprint-window';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

// Type guard functions
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

/** A single field's value is capped so one long field cannot crowd out the rest. */
const MAX_FIELD_VALUE_CHARS = 1500;

/**
 * Format the fields a caller asked for as `Name (id): value` lines.
 *
 * The id is kept alongside the name because it is what a follow-up JQL filter
 * needs, and because two custom fields are allowed to share a display name.
 */
function renderExtraFields(
  fields: Record<string, unknown>,
  names: unknown,
  requestedFields: string[],
  wantEveryField: boolean
): string[] {
  if (requestedFields.length === 0) return [];

  const fieldNames = isRecord(names) ? names : {};
  const label = (id: string) => (isString(fieldNames[id]) ? fieldNames[id] : id);

  const ids = wantEveryField
    ? Object.keys(fields)
        .filter((id) => !STANDARD_ISSUE_FIELDS.includes(id))
        .filter((id) => renderFieldValue(fields[id]) !== '')
        .sort((a, b) => label(a).localeCompare(label(b)))
    : requestedFields.filter((id) => id !== '*all');

  return ids.map((id) => {
    // Distinguish "Jira has no such field" from "the field is empty here": the
    // first means the caller should check the id, the second is an answer.
    if (!(id in fields)) {
      return `${label(id)} (${id}): not present on this issue`;
    }

    const value = renderFieldValue(fields[id]);
    if (!value) return `${label(id)} (${id}): (empty)`;

    const capped =
      value.length > MAX_FIELD_VALUE_CHARS
        ? `${value.slice(0, MAX_FIELD_VALUE_CHARS)}… (truncated)`
        : value;

    // Indent wrapped lines so a multi-line value stays visibly one field.
    return `${label(id)} (${id}): ${capped.replace(/\n/g, '\n  ')}`;
  });
}

export async function registerReadTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // whoami
  server.registerTool(
    'whoami',
    {
      title: 'Jira · Read — Who am I in Jira',
      description:
        'Returns the Atlassian account this connection acts as and the site it is pinned to.',
      annotations: { readOnlyHint: true },
    },
    async (_args: Record<string, unknown>) => {
      const cachedDisplayName = getCachedDisplayName(context.accountId);
      logger.debug('whoami invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName: cachedDisplayName,
        siteUrl: context.siteUrl,
      });
      try {
        logger.debug('whoami fetching user info', {
          component: 'mcp/tool',
          url: `${context.apiBaseUrl}/rest/api/3/myself`,
        });
        const response = await auth.fetch(granularJiraScopes('whoami', true), '/rest/api/3/myself');
        logger.debug('whoami fetch status', {
          component: 'mcp/tool',
          status: response.status,
          statusText: response.statusText,
        });
        if (!response.ok) return errText(await describeJiraAuthFailure(response));
        const me = await response.json();
        logger.debug('whoami response', { component: 'mcp/tool', data: me });
        if (!isRecord(me)) {
          logger.error('whoami invalid response format', {
            component: 'mcp/tool',
            received: typeof me,
          });
          return {
            content: [{ type: 'text' as const, text: 'Invalid response from API' }],
            isError: true,
          };
        }
        const accountId = String(me.accountId || 'unknown');
        const displayName = String(me.displayName || 'unknown');

        // Cache the displayName for logging
        if (me.accountId && me.displayName) {
          cacheUserDisplayName(String(me.accountId), String(me.displayName));
        }

        const lines = [
          `Account: ${displayName}`,
          `Email: ${me.emailAddress || 'not shared'}`,
          `Account ID: ${accountId}`,
          `Site: ${context.siteUrl}`,
        ];
        logger.debug('whoami success', { component: 'mcp/tool', displayName, accountId });
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        logger.error('whoami error', {
          component: 'mcp/tool',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_search_issues
  server.registerTool(
    'jira_search_issues',
    {
      title: 'Jira · Read — Search Jira issues with JQL',
      description:
        'Runs a JQL query and returns matching issues — with `fields`, one search replaces ' +
        'calling jira_get_issue once per issue. Results are capped at 100. ' +
        'Use `project = SCRUM` for a specific project or `status != Done` for filtering.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jql: z.string().describe(JQL_PARAMETER_DESCRIPTION),
        maxResults: z.number().describe('Maximum results (1-100, default 50)').optional(),
        fields: z
          .array(z.string().min(1))
          .max(20)
          .describe(
            'Extra issue fields to include per result (e.g. "description", "labels", ' +
              '"duedate", "components") — appended to the standard set'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_search_issues invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { jql } = args;
        const maxResults = Math.min(
          (isNumber(args.maxResults) ? args.maxResults : 50) || 50,
          context.maxJqlResults
        );

        if (!jql) {
          return {
            content: [{ type: 'text' as const, text: 'JQL query is required' }],
            isError: true,
          };
        }
        // Structural mistakes are answered here rather than forwarded, so the
        // caller gets a sentence it can act on instead of Jira's character
        // offset. Never rewritten — see jql.ts.
        const malformed = isString(jql) ? checkJql(jql) : null;
        if (malformed) return errText(describeJqlProblem(malformed));

        const extraFields = isArray(args.fields)
          ? args.fields.filter((field): field is string => typeof field === 'string' && !!field)
          : [];

        // /rest/api/3/search was removed by Atlassian (CHANGE-2046). Its
        // replacement pages by cursor rather than offset and, critically,
        // returns only issue ids unless `fields` is given explicitly.
        const response = await auth.fetch(
          granularJiraScopes('jira_search_issues', true),
          '/rest/api/3/search/jql',
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults,
              fields: [
                'summary',
                'status',
                'priority',
                'assignee',
                'reporter',
                'created',
                'updated',
                'issuetype',
                ...extraFields,
              ],
            }),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = await response.json();
        if (!isRecord(data)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid API response' }],
            isError: true,
          };
        }
        if (!isArray(data.issues)) {
          return {
            content: [{ type: 'text' as const, text: 'Expected issues array in response' }],
            isError: true,
          };
        }
        const issues = data.issues
          .map((issue: unknown) => {
            if (!isRecord(issue)) {
              return null;
            }
            if (!isRecord(issue.fields)) {
              return null;
            }
            const fields = issue.fields;
            // Caller-requested extras render as compact JSON — the caller
            // named the field, so the raw shape is what they asked for.
            const extras = extraFields
              .filter((field) => fields[field] !== undefined && fields[field] !== null)
              .map((field) => `${field}: ${JSON.stringify(fields[field]).slice(0, 500)}`)
              .join('; ');
            return {
              key: issue.key,
              summary: fields.summary,
              status: (isRecord(fields.status) ? fields.status.name : null) || 'Unknown',
              priority: (isRecord(fields.priority) ? fields.priority.name : null) || 'No Priority',
              assignee:
                (isRecord(fields.assignee) ? fields.assignee.displayName : null) || 'Unassigned',
              reporter: (isRecord(fields.reporter) ? fields.reporter.displayName : null) || null,
              updated: fields.updated,
              extras,
            };
          })
          .filter((issue): issue is NonNullable<typeof issue> => issue !== null);

        // The replacement response has no `total` — it is cursor-paged, and an
        // exact count needs a separate /search/approximate-count call.
        const more = typeof data.nextPageToken === 'string' && data.nextPageToken.length > 0;
        const lines = [
          `Showing ${issues.length} issue${issues.length === 1 ? '' : 's'}` +
            (more ? ' — more match. Call jira_count_issues with the same JQL for the total.' : '') +
            ':',
          ...issues.map(
            (i: Record<string, unknown>) =>
              `• ${i.key}: ${i.summary} [${i.status}] (${i.priority}) assigned to ${i.assignee}` +
              (i.reporter ? `, reported by ${i.reporter}` : '') +
              (i.extras ? ` — ${i.extras}` : '')
          ),
        ];

        if (issues.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Key, Summary, Status, Assignee) usually scans faster than this flat ' +
                  'list, especially with more than a handful of results.'
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // ——— Interactive results (MCP Apps) ————————————————————————————————
  // The read-side card: same search as jira_search_issues, rendered as a
  // clickable list instead of flat text the model has to re-format. The text
  // result carries only keys, so the model can chain into other tools
  // without the full rows entering its context.
  server.registerTool(
    'jira_search_issues_preview',
    {
      title: 'Jira · Read — Search issues, rendered as a card',
      description:
        'Run a JQL query and render the matching issues as an interactive card with ' +
        '"Open in Jira" links. Prefer this over jira_search_issues when the user wants to SEE ' +
        'the results ("show me", "list my issues"); use jira_search_issues when you need the ' +
        'full rows to reason over. After calling, do not repeat the rows in your reply — ' +
        'reference issue keys only.',
      annotations: { readOnlyHint: true },
      _meta: previewToolMeta(RESULTS_LIST_URI),
      inputSchema: z.object({
        jql: z.string().describe(JQL_PARAMETER_DESCRIPTION),
        maxResults: z.number().describe('Maximum results (1-100, default 50)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      try {
        const { jql } = args;
        if (!jql) return errText('JQL query is required');
        const malformed = isString(jql) ? checkJql(jql) : null;
        if (malformed) return errText(describeJqlProblem(malformed));
        const maxResults = Math.min(
          (isNumber(args.maxResults) ? args.maxResults : 50) || 50,
          context.maxJqlResults
        );

        const response = await auth.fetch(
          granularJiraScopes('jira_search_issues', true),
          '/rest/api/3/search/jql',
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults,
              fields: [
                'summary',
                'status',
                'priority',
                'assignee',
                'reporter',
                'updated',
                'issuetype',
              ],
            }),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));
        const data = await response.json();
        if (!isRecord(data) || !isArray(data.issues)) return errText('Invalid API response');

        // Jira's own board semantics ride along: chips take their tone from
        // the status CATEGORY (To Do / In Progress / Done render right in
        // both themes without hardcoding per-status colors), groups follow
        // board order, and priority gets its own chip on the row.
        const categoryTone = (key: string) =>
          key === 'new'
            ? 'todo'
            : key === 'indeterminate'
              ? 'progress'
              : key === 'done'
                ? 'done'
                : 'neutral';
        const categoryOrder = (key: string) =>
          key === 'new' ? 0 : key === 'indeterminate' ? 1 : key === 'done' ? 2 : 3;
        const priorityTone = (name: string) =>
          /^(highest|high)$/i.test(name) ? 'urgent' : /^medium$/i.test(name) ? 'warn' : 'neutral';
        const avatarOf = (user: unknown) => {
          const avatars = isRecord(user) && isRecord(user.avatarUrls) ? user.avatarUrls : {};
          const url = avatars['24x24'] ?? avatars['32x32'] ?? avatars['48x48'];
          return typeof url === 'string' ? url : '';
        };

        interface CardRow {
          key: string;
          title: string;
          meta: string;
          chips: { label: string; tone: string }[];
          people: { name: string; avatarUrl?: string; role: string }[];
          links: { label: string; url: string }[];
        }
        const grouped = new Map<string, { order: number; tone: string; rows: CardRow[] }>();
        for (const issue of data.issues.filter(isRecord)) {
          const fields = isRecord(issue.fields) ? issue.fields : {};
          const key = String(issue.key ?? '');
          const status = isRecord(fields.status) ? fields.status : {};
          const statusName = String(status.name ?? 'Unknown');
          const category = isRecord(status.statusCategory)
            ? String(status.statusCategory.key ?? '')
            : '';
          const type = (isRecord(fields.issuetype) ? fields.issuetype.name : null) || '';
          const priority = (isRecord(fields.priority) ? fields.priority.name : null) || '';
          const assignee = isRecord(fields.assignee) ? fields.assignee : null;
          const reporter = isRecord(fields.reporter) ? fields.reporter : null;

          const row: CardRow = {
            key,
            title: `${key} — ${String(fields.summary ?? '')}`,
            meta: String(type),
            chips: priority
              ? [{ label: String(priority), tone: priorityTone(String(priority)) }]
              : [],
            people: [
              {
                name: String(assignee?.displayName ?? 'Unassigned'),
                ...(assignee ? { avatarUrl: avatarOf(assignee) } : {}),
                role: 'assignee',
              },
              ...(reporter
                ? [
                    {
                      name: String(reporter.displayName ?? ''),
                      avatarUrl: avatarOf(reporter),
                      role: 'reporter',
                    },
                  ]
                : []),
            ],
            links: await issueLinkTargets(context.siteUrl, auth, key),
          };
          const group = grouped.get(statusName) ?? {
            order: categoryOrder(category),
            tone: categoryTone(category),
            rows: [],
          };
          group.rows.push(row);
          grouped.set(statusName, group);
        }
        const groups = [...grouped.entries()]
          .sort((a, b) => a[1].order - b[1].order)
          .map(([label, group]) => ({
            label,
            chip: { label, tone: group.tone },
            rows: group.rows.map(({ key: _key, ...row }) => row),
          }));

        const more = typeof data.nextPageToken === 'string' && data.nextPageToken.length > 0;
        const keys = [...grouped.values()].flatMap((group) => group.rows.map((row) => row.key));
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${keys.length} issue${keys.length === 1 ? '' : 's'} rendered on the card, grouped by status` +
                (more ? ' (more match — jira_count_issues gives the total)' : '') +
                (keys.length > 0 ? `: ${keys.join(', ')}` : '.') +
                ' Do not repeat the rows; the user sees them on the card.',
            },
          ],
          structuredContent: {
            kind: 'results',
            title: 'Jira issues',
            subtitle: String(jql),
            groups,
            // Duplicates the group rows flat, deliberately: hosts cache
            // templates aggressively (a whole conversation can hold the
            // previous bundle), and a template that predates `groups` falls
            // back to this and still shows the data — ungrouped beats an
            // empty card lying "No results."
            rows: groups.flatMap((group) => group.rows),
            ...(more ? { footer: 'More issues match this query than shown here.' } : {}),
          },
        };
      } catch (error) {
        return errText(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // jira_count_issues
  server.registerTool(
    'jira_count_issues',
    {
      title: 'Jira · Read — Count issues matching JQL',
      description:
        'How many issues match a JQL query, without listing them. Use this when the question is ' +
        '"how many" — jira_search_issues returns at most 100 and its response carries no total, so a ' +
        'capped result says nothing about how many there really are.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jql: z.string().describe(JQL_PARAMETER_DESCRIPTION),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_count_issues invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { jql } = args;
        if (!isString(jql) || jql.trim().length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'JQL query is required' }],
            isError: true,
          };
        }
        const malformed = checkJql(jql);
        if (malformed) return errText(describeJqlProblem(malformed));

        // The endpoint that replaced the removed /search's `total` (CHANGE-2046).
        // Its answer is an estimate by design — Jira does not count exactly on a
        // large result set — so it is reported as one rather than as a fact.
        const response = await auth.fetch(
          granularJiraScopes('jira_count_issues', true),
          '/rest/api/3/search/approximate-count',
          { method: 'POST', body: JSON.stringify({ jql }) }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = await response.json();
        if (!isRecord(data) || !isNumber(data.count)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid API response' }],
            isError: true,
          };
        }

        const approximate = data.count === 1 ? '1 issue matches' : `${data.count} issues match`;
        return {
          content: [
            {
              type: 'text' as const,
              text: `${approximate} (Jira's approximate count):\n${jql}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_get_issue
  server.registerTool(
    'jira_get_issue',
    {
      title: 'Jira · Read — Read a Jira issue',
      description:
        'Get detailed information about a specific Jira issue. Pass `fields` to include ' +
        'custom fields — their values are printed, not just matched, so this reads back ' +
        'what a JQL filter on the same field found.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        fields: z
          .array(z.string())
          .describe(
            'Extra fields to include beyond the standard set. Accepts field ids ' +
              '("customfield_12013"), bare custom field numbers ("12013"), the JQL ' +
              'spelling ("cf[12013]"), or system field names ("labels", "components"). ' +
              'Pass ["*all"] to list every field that has a value on the issue.'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_get_issue invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'Issue key is required' }],
            isError: true,
          };
        }

        const requestedFields = (isArray(args.fields) ? args.fields.filter(isString) : []).map(
          normalizeFieldId
        );
        const wantEveryField = requestedFields.includes('*all');

        // Naming any field restricts the response to that list, so the standard
        // set has to be asked for alongside it. `expand=names` carries the
        // human-readable field names in the same round trip, which is what
        // turns `customfield_12013` into "Decision of Change Request".
        const query = new URLSearchParams();
        if (wantEveryField) {
          query.set('fields', '*all');
        } else if (requestedFields.length > 0) {
          query.set('fields', [...STANDARD_ISSUE_FIELDS, ...requestedFields].join(','));
        }
        if (requestedFields.length > 0) query.set('expand', 'names');

        const queryString = query.toString();
        const response = await auth.fetch(
          granularJiraScopes('jira_get_issue', true),
          `/rest/api/3/issue/${encodeURIComponent(String(issueKey))}` +
            (queryString ? `?${queryString}` : '')
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const issue = await response.json();
        if (!isRecord(issue)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid API response' }],
            isError: true,
          };
        }
        if (!isRecord(issue.fields)) {
          return {
            content: [{ type: 'text' as const, text: 'Expected fields object in issue' }],
            isError: true,
          };
        }
        const fields = issue.fields;
        const lines = [
          `${issue.key}: ${fields.summary}`,
          `Status: ${(isRecord(fields.status) ? fields.status.name : null) || 'Unknown'}`,
          `Priority: ${(isRecord(fields.priority) ? fields.priority.name : null) || 'No Priority'}`,
          `Type: ${(isRecord(fields.issuetype) ? fields.issuetype.name : null) || 'Unknown'}`,
          `Assignee: ${(isRecord(fields.assignee) ? fields.assignee.displayName : null) || 'Unassigned'}`,
          `Created: ${fields.created}`,
          `Updated: ${fields.updated}`,
        ];

        // Issue links as a readable section — the phrase, the other end and
        // its status, and the link id jira_delete_issue_link needs — instead of
        // the raw JSON dump the generic field renderer produced.
        const linkLines: string[] = [];
        if (Array.isArray(fields.issuelinks)) {
          for (const link of fields.issuelinks) {
            if (!isRecord(link)) continue;
            const outward = isRecord(link.outwardIssue) ? link.outwardIssue : null;
            const inward = isRecord(link.inwardIssue) ? link.inwardIssue : null;
            const other = outward ?? inward;
            if (!other) continue;
            const type: Record<string, unknown> = isRecord(link.type) ? link.type : {};
            const phrase = outward ? type.outward : type.inward;
            const otherFields: Record<string, unknown> = isRecord(other.fields) ? other.fields : {};
            const status = isRecord(otherFields.status) ? otherFields.status.name : null;
            linkLines.push(
              `• ${typeof phrase === 'string' ? phrase : 'linked to'} ${String(other.key)}` +
                `${typeof status === 'string' ? ` [${status}]` : ''} (link ID: ${String(link.id)})`
            );
          }
        }
        if (linkLines.length > 0) {
          lines.push('', 'Links:', ...linkLines);
        }

        const extras = renderExtraFields(fields, issue.names, requestedFields, wantEveryField);
        if (extras.length > 0) {
          lines.push('', 'Fields:', ...extras);
        }

        // The description is ADF, so it needs the same flattening as any other
        // rich-text field — printing the node tree is where [object Object] came
        // from.
        const description = renderFieldValue(fields.description);
        if (description) {
          lines.push(`\nDescription:\n${description}`);
        }

        const resolvedIssueKey = isString(issue.key) ? issue.key : String(issue.key);
        const text = `${lines.join('\n')}\n\n${await issueLinksMarkdown(context.siteUrl, auth, resolvedIssueKey)}`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_list_boards
  server.registerTool(
    'jira_list_boards',
    {
      title: 'Jira · Read — List Jira Software boards (use this when looking for sprints)',
      description: 'List Jira Software boards (Scrum and Kanban).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        maxResults: z.number().describe('Maximum results (1-100, default 25)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_boards invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const maxResults = Math.min((isNumber(args.maxResults) ? args.maxResults : 25) || 25, 100);

        const response = await auth.fetch(
          granularJiraScopes('jira_list_boards', true),
          `/rest/agile/1.0/board?maxResults=${maxResults}`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = await response.json();
        if (!isRecord(data)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid API response' }],
            isError: true,
          };
        }
        if (!isArray(data.values)) {
          return {
            content: [{ type: 'text' as const, text: 'Expected values array in response' }],
            isError: true,
          };
        }
        const boards = data.values
          .map((board: unknown) => {
            if (!isRecord(board)) {
              return null;
            }
            return {
              id: board.id,
              name: board.name,
              type: board.type,
            };
          })
          .filter((board): board is NonNullable<typeof board> => board !== null);

        const lines = [
          `Found ${data.total || 0} boards (showing ${boards.length}):`,
          ...boards.map(
            (b: Record<string, unknown>) => `• ${b.name} (${b.type}) — boardId: ${b.id}`
          ),
        ];

        if (boards.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Board, Type, id) usually scans faster than this flat list.'
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  // jira_list_sprints
  server.registerTool(
    'jira_list_sprints',
    {
      title: 'Jira · Read — List sprints on a board',
      description: 'List sprints for a Jira Software board.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: z.string().describe('Board ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_sprints invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { boardId } = args;

        if (!boardId) {
          return {
            content: [{ type: 'text' as const, text: 'Board ID is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_list_sprints', true),
          `/rest/agile/1.0/board/${boardId}/sprint`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = await response.json();
        if (!isRecord(data)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid API response' }],
            isError: true,
          };
        }
        const sprints = isArray(data.values) ? data.values : [];

        const now = new Date();
        const sprintLines = sprints
          .map((s: unknown) => {
            if (!isRecord(s)) {
              return null;
            }
            const dates = {
              startDate: typeof s.startDate === 'string' ? s.startDate : undefined,
              endDate: typeof s.endDate === 'string' ? s.endDate : undefined,
            };
            // "How long is left" only means something for the sprint that is
            // running; on fourteen closed ones it is fourteen lines of noise.
            const progress = s.state === 'active' ? sprintProgress(dates, now) : '';
            // The id feeds jira_move_issue_to_sprint / jira_complete_sprint — the
            // last member of the ids-missing-from-list-output family. The dates
            // ride along because Jira sent them and the question after "which
            // sprint is active" is always "and when does it end".
            return (
              `• ${s.name} (${s.state}) — sprintId: ${s.id} — ` +
              `${sprintWindow(dates)}${progress ? `, ${progress}` : ''}`
            );
          })
          .filter((line): line is string => line !== null);
        const lines = [`Board ${boardId} has ${sprints.length} sprints:`, ...sprintLines];

        if (sprintLines.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Sprint, State, Start, End) usually scans faster than this flat list.'
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );
}
