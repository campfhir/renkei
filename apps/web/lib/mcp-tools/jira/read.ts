/**
 * Read-only tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, issueUrl, cacheUserDisplayName, getCachedDisplayName } from '../common';
import { STANDARD_ISSUE_FIELDS, normalizeFieldId, renderFieldValue } from './fields';
import { logger } from '@/lib/logger';

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

export async function registerReadTools(server: McpServer, context: MCPToolContext): Promise<void> {
  // whoami
  server.registerTool(
    'whoami',
    {
      title: 'Who am I in Jira',
      description:
        'Returns the Atlassian account this connection acts as and the site it is pinned to.',
      annotations: { readOnlyHint: true },
    },
    async (_args: Record<string, unknown>) => {
      const cachedDisplayName = getCachedDisplayName(context.accountId);
      logger.info('whoami invoked', {
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
        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/myself`,
          context.accessToken
        );
        logger.debug('whoami fetch status', {
          component: 'mcp/tool',
          status: response.status,
          statusText: response.statusText,
        });
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
        logger.info('whoami success', { component: 'mcp/tool', displayName, accountId });
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

  // search_issues
  server.registerTool(
    'search_issues',
    {
      title: 'Search Jira issues with JQL',
      description:
        'Runs a JQL query and returns matching issues. Results are capped at 100. ' +
        'Use `project = SCRUM` for a specific project or `status != Done` for filtering.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jql: z
          .string()
          .describe('JQL query, e.g. "project = SCRUM AND status != Done ORDER BY updated DESC"'),
        maxResults: z.number().describe('Maximum results (1-100, default 50)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('search_issues invoked', {
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

        // /rest/api/3/search was removed by Atlassian (CHANGE-2046). Its
        // replacement pages by cursor rather than offset and, critically,
        // returns only issue ids unless `fields` is given explicitly.
        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/search/jql`,
          context.accessToken,
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
                'created',
                'updated',
                'issuetype',
              ],
            }),
          }
        );

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
            return {
              key: issue.key,
              summary: fields.summary,
              status: (isRecord(fields.status) ? fields.status.name : null) || 'Unknown',
              priority: (isRecord(fields.priority) ? fields.priority.name : null) || 'No Priority',
              assignee:
                (isRecord(fields.assignee) ? fields.assignee.displayName : null) || 'Unassigned',
              updated: fields.updated,
            };
          })
          .filter((issue): issue is NonNullable<typeof issue> => issue !== null);

        // The replacement response has no `total` — it is cursor-paged, and an
        // exact count needs a separate /search/approximate-count call.
        const more = typeof data.nextPageToken === 'string' && data.nextPageToken.length > 0;
        const lines = [
          `Showing ${issues.length} issue${issues.length === 1 ? '' : 's'}` +
            (more ? ' — more match. Call count_issues with the same JQL for the total.' : '') +
            ':',
          ...issues.map(
            (i: Record<string, unknown>) =>
              `• ${i.key}: ${i.summary} [${i.status}] (${i.priority}) assigned to ${i.assignee}`
          ),
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // count_issues
  server.registerTool(
    'count_issues',
    {
      title: 'Count issues matching JQL',
      description:
        'How many issues match a JQL query, without listing them. Use this when the question is ' +
        '"how many" — search_issues returns at most 100 and its response carries no total, so a ' +
        'capped result says nothing about how many there really are.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jql: z
          .string()
          .describe(
            'JQL query, e.g. "assignee = \'someone@example.com\' AND resolution = Unresolved"'
          ),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('count_issues invoked', {
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

        // The endpoint that replaced the removed /search's `total` (CHANGE-2046).
        // Its answer is an estimate by design — Jira does not count exactly on a
        // large result set — so it is reported as one rather than as a fact.
        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/search/approximate-count`,
          context.accessToken,
          { method: 'POST', body: JSON.stringify({ jql }) }
        );

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

  // get_issue
  server.registerTool(
    'get_issue',
    {
      title: 'Read a Jira issue',
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
      logger.info('get_issue invoked', {
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
        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${encodeURIComponent(String(issueKey))}` +
            (queryString ? `?${queryString}` : ''),
          context.accessToken
        );

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
        // its status, and the link id delete_issue_link needs — instead of
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
        const text = `${lines.join('\n')}\n\n[Open in Jira](${issueUrl(context.siteUrl, resolvedIssueKey)})`;
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

  // list_boards
  server.registerTool(
    'list_boards',
    {
      title: 'List Jira Software boards (use this when looking for sprints)',
      description: 'List Jira Software boards (Scrum and Kanban).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        maxResults: z.number().describe('Maximum results (1-100, default 25)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('list_boards invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const maxResults = Math.min((isNumber(args.maxResults) ? args.maxResults : 25) || 25, 100);

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/agile/1.0/board?maxResults=${maxResults}`,
          context.accessToken
        );

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

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // list_sprints
  server.registerTool(
    'list_sprints',
    {
      title: 'List sprints on a board',
      description: 'List sprints for a Jira Software board.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: z.string().describe('Board ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('list_sprints invoked', {
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

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/agile/1.0/board/${boardId}/sprint`,
          context.accessToken
        );

        const data = await response.json();
        if (!isRecord(data)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid API response' }],
            isError: true,
          };
        }
        const sprints = isArray(data.values) ? data.values : [];

        const lines = [
          `Board ${boardId} has ${sprints.length} sprints:`,
          ...sprints
            .map((s: unknown) => {
              if (!isRecord(s)) {
                return null;
              }
              // The id feeds move_issue_to_sprint / complete_sprint — the
              // last member of the ids-missing-from-list-output family.
              return `• ${s.name} (${s.state}) — sprintId: ${s.id}`;
            })
            .filter((line): line is string => line !== null),
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
