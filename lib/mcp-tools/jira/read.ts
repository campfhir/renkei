/**
 * Read-only tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, okWithLink, toolError, jiraFetch, issueUrl } from '../common';

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

export interface ReadToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: (context: MCPToolContext, params: unknown) => Promise<MCPToolResult>;
}

export const readTools: ReadToolHandler[] = [
  {
    name: 'whoami',
    description:
      'Returns the Atlassian account this connection acts as and the site it is pinned to.',
    handler: async (context) => {
      const response = await jiraFetch(`${context.siteUrl}/rest/api/3/myself`, context.accessToken);
      const me = await response.json();
      if (!isRecord(me)) {
        return toolError('Invalid response from API');
      }
      const lines = [
        `Account: ${me.displayName || 'unknown'}`,
        `Email: ${me.emailAddress || 'not shared'}`,
        `Account ID: ${me.accountId || 'unknown'}`,
        `Site: ${context.siteUrl}`,
      ];
      return ok(lines.join('\n'));
    },
  },

  {
    name: 'search_issues',
    description:
      'Runs a JQL query and returns matching issues. Results are capped at 100. ' +
      'Use `project = SCRUM` for a specific project or `status != Done` for filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: {
          type: 'string',
          description: 'JQL query, e.g. "project = SCRUM AND status != Done ORDER BY updated DESC"',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results (1-100, default 50)',
        },
      },
      required: ['jql'],
    },
    handler: async (context, params) => {
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const { jql } = p;
      const maxResults = Math.min(
        (isNumber(p.maxResults) ? p.maxResults : 50) || 50,
        context.maxJqlResults
      );

      if (!jql) {
        return toolError('JQL query is required');
      }

      try {
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
          return toolError('Invalid API response');
        }
        if (!isArray(data.issues)) {
          return toolError('Expected issues array in response');
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

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(
          `Search failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },

  {
    name: 'get_issue',
    description: 'Get detailed information about a specific Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
      },
      required: ['issueKey'],
    },
    handler: async (context, params) => {
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const { issueKey } = p;

      if (!issueKey) {
        return toolError('Issue key is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}`,
          context.accessToken
        );

        const issue = await response.json();
        if (!isRecord(issue)) {
          return toolError('Invalid API response');
        }
        if (!isRecord(issue.fields)) {
          return toolError('Expected fields object in issue');
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
        return okWithLink(lines.join('\n'), issueUrl(context.siteUrl, resolvedIssueKey));
      } catch (error) {
        return toolError(
          `Failed to get issue: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },

  {
    name: 'list_boards',
    description: 'List Jira Software boards (Scrum and Kanban).',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: {
          type: 'number',
          description: 'Maximum results (1-100, default 25)',
        },
      },
    },
    handler: async (context, params) => {
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const maxResults = Math.min((isNumber(p.maxResults) ? p.maxResults : 25) || 25, 100);

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/boards?maxResults=${maxResults}`,
          context.accessToken
        );

        const data = await response.json();
        if (!isRecord(data)) {
          return toolError('Invalid API response');
        }
        if (!isArray(data.values)) {
          return toolError('Expected values array in response');
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

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(
          `Failed to list boards: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },

  {
    name: 'list_sprints',
    description: 'List sprints for a Jira Software board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID',
        },
      },
      required: ['boardId'],
    },
    handler: async (context, params) => {
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const { boardId } = p;

      if (!boardId) {
        return toolError('Board ID is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/board/${boardId}/sprints`,
          context.accessToken
        );

        const data = await response.json();
        if (!isRecord(data)) {
          return toolError('Invalid API response');
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

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(
          `Failed to list sprints: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
];
