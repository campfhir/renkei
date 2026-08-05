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
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
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
      const me = (await response.json()) as any;
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
      const { jql } = params;
      const maxResults = Math.min(params.maxResults || 50, context.maxJqlResults);

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

        const data = (await response.json()) as any;
        const issues = (data.issues || []).map((issue: any) => ({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name || 'Unknown',
          priority: issue.fields.priority?.name || 'No Priority',
          assignee: issue.fields.assignee?.displayName || 'Unassigned',
          updated: issue.fields.updated,
        }));

        const lines = [
          `Found ${data.total} issues (showing ${issues.length}):`,
          ...issues.map(
            (i: any) =>
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
      const { issueKey } = params;

      if (!issueKey) {
        return toolError('Issue key is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}`,
          context.accessToken,
        );

        const issue = (await response.json()) as any;
        const lines = [
          `${issue.key}: ${issue.fields.summary}`,
          `Status: ${issue.fields.status?.name || 'Unknown'}`,
          `Priority: ${issue.fields.priority?.name || 'No Priority'}`,
          `Type: ${issue.fields.issuetype?.name || 'Unknown'}`,
          `Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}`,
          `Created: ${issue.fields.created}`,
          `Updated: ${issue.fields.updated}`,
        ];

        if (issue.fields.description) {
          lines.push(`\nDescription:\n${issue.fields.description}`);
        }

        return okWithLink(lines.join('\n'), issueUrl(context.siteUrl, issue.key));
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
      const maxResults = Math.min(params.maxResults || 25, 100);

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/boards?maxResults=${maxResults}`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const boards = (data.values || []).map((board: any) => ({
          id: board.id,
          name: board.name,
          type: board.type,
        }));

        const lines = [
          `Found ${data.total || 0} boards (showing ${boards.length}):`,
          ...boards.map((b: any) => `• ${b.name} (${b.type})`),
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
      const { boardId } = params;

      if (!boardId) {
        return toolError('Board ID is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/board/${boardId}/sprints`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const sprints = data.values || [];

        const lines = [
          `Board ${boardId} has ${sprints.length} sprints:`,
          ...sprints.map((s: any) => `• ${s.name} (${s.state})`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list sprints: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
