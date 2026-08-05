/**
 * Read-only tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { MCPToolContext, MCPToolResult } from '../common';
import { issueKeySchema, ok, okWithLink, toolError, jiraFetch, issueUrl } from '../common';

export interface ReadToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: (context: MCPToolContext, params: unknown) => Promise<MCPToolResult>;
}

export const readTools: ReadToolHandler[] = [
  {
    name: 'whoami',
    description: 'Returns the Atlassian account this connection acts as and the site it is pinned to.',
    handler: async (context) => {
      const response = await jiraFetch(
        `${context.siteUrl}/rest/api/3/myself`,
        context.accessToken,
      );
      const me = (await response.json()) as Record<string, unknown>;
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
      const p = params as Record<string, unknown>;
      const { jql } = p;
      const maxResults = Math.min((p.maxResults as number | undefined) || 50, context.maxJqlResults);

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
          },
        );

        const data = (await response.json()) as Record<string, unknown>;
        const issues = ((data.issues as unknown[]) || []).map((issue: unknown) => {
          const issueObj = issue as Record<string, unknown>;
          const fields = issueObj.fields as Record<string, unknown>;
          return {
            key: issueObj.key,
            summary: fields.summary,
            status: (fields.status as Record<string, unknown>)?.name || 'Unknown',
            priority: (fields.priority as Record<string, unknown>)?.name || 'No Priority',
            assignee: (fields.assignee as Record<string, unknown>)?.displayName || 'Unassigned',
            updated: fields.updated,
          };
        });

        const lines = [
          `Found ${data.total} issues (showing ${issues.length}):`,
          ...issues.map(
            (i: Record<string, unknown>) =>
              `• ${i.key}: ${i.summary} [${i.status}] (${i.priority}) assigned to ${i.assignee}`,
          ),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
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
      const p = params as Record<string, unknown>;
      const { issueKey } = p;

      if (!issueKey) {
        return toolError('Issue key is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}`,
          context.accessToken,
        );

        const issue = (await response.json()) as Record<string, unknown>;
        const fields = issue.fields as Record<string, unknown>;
        const lines = [
          `${issue.key}: ${fields.summary}`,
          `Status: ${(fields.status as Record<string, unknown>)?.name || 'Unknown'}`,
          `Priority: ${(fields.priority as Record<string, unknown>)?.name || 'No Priority'}`,
          `Type: ${(fields.issuetype as Record<string, unknown>)?.name || 'Unknown'}`,
          `Assignee: ${(fields.assignee as Record<string, unknown>)?.displayName || 'Unassigned'}`,
          `Created: ${fields.created}`,
          `Updated: ${fields.updated}`,
        ];

        if (fields.description) {
          lines.push(`\nDescription:\n${fields.description}`);
        }

        return okWithLink(lines.join('\n'), issueUrl(context.siteUrl, issue.key as string));
      } catch (error) {
        return toolError(`Failed to get issue: ${error instanceof Error ? error.message : String(error)}`);
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
      const p = params as Record<string, unknown>;
      const maxResults = Math.min((p.maxResults as number | undefined) || 25, 100);

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/boards?maxResults=${maxResults}`,
          context.accessToken,
        );

        const data = (await response.json()) as Record<string, unknown>;
        const boards = ((data.values as unknown[]) || []).map((board: unknown) => {
          const boardObj = board as Record<string, unknown>;
          return {
            id: boardObj.id,
            name: boardObj.name,
            type: boardObj.type,
          };
        });

        const lines = [
          `Found ${data.total || 0} boards (showing ${boards.length}):`,
          ...boards.map((b: Record<string, unknown>) => `• ${b.name} (${b.type})`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list boards: ${error instanceof Error ? error.message : String(error)}`);
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
      const p = params as Record<string, unknown>;
      const { boardId } = p;

      if (!boardId) {
        return toolError('Board ID is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/board/${boardId}/sprints`,
          context.accessToken,
        );

        const data = (await response.json()) as Record<string, unknown>;
        const sprints = (data.values as unknown[]) || [];

        const lines = [
          `Board ${boardId} has ${sprints.length} sprints:`,
          ...sprints.map((s: unknown) => {
            const sprintObj = s as Record<string, unknown>;
            return `• ${sprintObj.name} (${sprintObj.state})`;
          }),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list sprints: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
