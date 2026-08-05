/**
 * Read-only tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MCPToolContext } from '../common';
import { jiraFetch, issueUrl } from '../common';

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
      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/myself`,
          context.accessToken
        );
        const me = await response.json();
        if (!isRecord(me)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid response from API' }],
            isError: true,
          };
        }
        const lines = [
          `Account: ${me.displayName || 'unknown'}`,
          `Email: ${me.emailAddress || 'not shared'}`,
          `Account ID: ${me.accountId || 'unknown'}`,
          `Site: ${context.siteUrl}`,
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
    async (_args: Record<string, unknown>) => {
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

        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/search`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults,
              fields: [
                'key',
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

        const lines = [
          `Found ${data.total} issues (showing ${issues.length}):`,
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

  // get_issue
  server.registerTool(
    'get_issue',
    {
      title: 'Read a Jira issue',
      description: 'Get detailed information about a specific Jira issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (_args: Record<string, unknown>) => {
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'Issue key is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}`,
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

        if (fields.description) {
          lines.push(`\nDescription:\n${fields.description}`);
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
    async (_args: Record<string, unknown>) => {
      try {
        const maxResults = Math.min((isNumber(args.maxResults) ? args.maxResults : 25) || 25, 100);

        const response = await jiraFetch(
          `${context.siteUrl}/rest/agile/1.0/board?maxResults=${maxResults}`,
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
          ...boards.map((b: Record<string, unknown>) => `• ${b.name} (${b.type})`),
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
    async (_args: Record<string, unknown>) => {
      try {
        const { boardId } = args;

        if (!boardId) {
          return {
            content: [{ type: 'text' as const, text: 'Board ID is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/agile/1.0/board/${boardId}/sprint`,
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
              return `• ${s.name} (${s.state})`;
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
