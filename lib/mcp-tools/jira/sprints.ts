/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Sprint and board management tools for Jira MCP.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, okWithLink, toolError, jiraFetch, sprintUrl } from '../common';

export interface SprintToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const sprintTools: SprintToolHandler[] = [
  {
    name: 'create_sprint',
    description: 'Create a new sprint on a Jira Software board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID',
        },
        name: {
          type: 'string',
          description: 'Sprint name',
        },
        startDate: {
          type: 'string',
          description: 'Sprint start date (ISO format, optional)',
        },
        endDate: {
          type: 'string',
          description: 'Sprint end date (ISO format, optional)',
        },
        goal: {
          type: 'string',
          description: 'Sprint goal (optional)',
        },
      },
      required: ['boardId', 'name'],
    },
    handler: async (context, params) => {
      const { boardId, name, startDate, endDate, goal } = params;

      if (!boardId || !name) {
        return toolError('boardId and name are required');
      }

      try {
        const body: any = { name };
        if (startDate) body.startDate = startDate;
        if (endDate) body.endDate = endDate;
        if (goal) body.goal = goal;

        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/board/${boardId}/sprint`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        );

        await response.json();
        return okWithLink(`Created sprint "${name}"`, sprintUrl(context.siteUrl, boardId));
      } catch (error) {
        return toolError(`Failed to create sprint: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'move_issue_to_sprint',
    description: 'Move an issue to a sprint.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
        sprintId: {
          type: 'string',
          description: 'Target sprint ID',
        },
      },
      required: ['issueKey', 'sprintId'],
    },
    handler: async (context, params) => {
      const { issueKey, sprintId } = params;

      if (!issueKey || !sprintId) {
        return toolError('issueKey and sprintId are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}`,
          context.accessToken,
          {
            method: 'PUT',
            body: JSON.stringify({
              fields: {
                sprint: sprintId,
              },
            }),
          },
        );

        return ok(`Moved ${issueKey} to sprint ${sprintId}`);
      } catch (error) {
        return toolError(`Failed to move issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'remove_issue_from_sprint',
    description: 'Remove an issue from its current sprint.',
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
        return toolError('issueKey is required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}`,
          context.accessToken,
          {
            method: 'PUT',
            body: JSON.stringify({
              fields: {
                sprint: null,
              },
            }),
          },
        );

        return ok(`Removed ${issueKey} from sprint`);
      } catch (error) {
        return toolError(`Failed to remove issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'complete_sprint',
    description: 'Complete (close) a sprint.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID',
        },
        sprintId: {
          type: 'string',
          description: 'Sprint ID to complete',
        },
      },
      required: ['boardId', 'sprintId'],
    },
    handler: async (context, params) => {
      const { boardId, sprintId } = params;

      if (!boardId || !sprintId) {
        return toolError('boardId and sprintId are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/api/3/board/${boardId}/sprint/${sprintId}/close`,
          context.accessToken,
          {
            method: 'POST',
          },
        );

        return ok(`Completed sprint ${sprintId}`);
      } catch (error) {
        return toolError(`Failed to complete sprint: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
