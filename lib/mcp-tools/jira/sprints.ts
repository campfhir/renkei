/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Sprint and board management tools for Jira MCP.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, sprintUrl, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerSprintTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // create_sprint
  server.registerTool(
    'create_sprint',
    {
      title: 'Create a sprint',
      description: 'Create a new sprint on a Jira Software board.',
      inputSchema: z.object({
        boardId: z.string().describe('Board ID'),
        name: z.string().describe('Sprint name'),
        startDate: z.string().describe('Sprint start date (ISO format, optional)').optional(),
        endDate: z.string().describe('Sprint end date (ISO format, optional)').optional(),
        goal: z.string().describe('Sprint goal (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] create_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { boardId, name, startDate, endDate, goal } = args;

        if (!boardId || !name) {
          return {
            content: [{ type: 'text' as const, text: 'boardId and name are required' }],
            isError: true,
          };
        }

        const body: any = { name, originBoardId: parseInt(String(boardId)) };
        if (startDate) body.startDate = startDate;
        if (endDate) body.endDate = endDate;
        if (goal) body.goal = goal;

        await jiraFetch(`${context.apiBaseUrl}/rest/agile/1.0/sprint`, context.accessToken, {
          method: 'POST',
          body: JSON.stringify(body),
        });

        const text = `Created sprint "${name}"\n\n[Open in Jira](${sprintUrl(context.siteUrl, String(boardId))})`;
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

  // move_issue_to_sprint
  server.registerTool(
    'move_issue_to_sprint',
    {
      title: 'Move a Jira issue to a sprint',
      description: 'Move an issue to a sprint.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        sprintId: z.string().describe('Target sprint ID'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] move_issue_to_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, sprintId } = args;

        if (!issueKey || !sprintId) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and sprintId are required' }],
            isError: true,
          };
        }

        await jiraFetch(`${context.apiBaseUrl}/rest/api/3/issue/${issueKey}`, context.accessToken, {
          method: 'PUT',
          body: JSON.stringify({
            fields: {
              sprint: sprintId,
            },
          }),
        });

        return {
          content: [{ type: 'text' as const, text: `Moved ${issueKey} to sprint ${sprintId}` }],
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

  // remove_issue_from_sprint
  server.registerTool(
    'remove_issue_from_sprint',
    {
      title: 'Remove an issue from a sprint',
      description: 'Remove an issue from its current sprint.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] remove_issue_from_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        await jiraFetch(`${context.apiBaseUrl}/rest/api/3/issue/${issueKey}`, context.accessToken, {
          method: 'PUT',
          body: JSON.stringify({
            fields: {
              sprint: null,
            },
          }),
        });

        return { content: [{ type: 'text' as const, text: `Removed ${issueKey} from sprint` }] };
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

  // complete_sprint
  server.registerTool(
    'complete_sprint',
    {
      title: 'Complete a Scrum sprint',
      description: 'Complete (close) a sprint.',
      inputSchema: z.object({
        boardId: z.string().describe('Board ID'),
        sprintId: z.string().describe('Sprint ID to complete'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] complete_sprint invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { sprintId } = args;

        if (!sprintId) {
          return {
            content: [{ type: 'text' as const, text: 'sprintId is required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/agile/1.0/sprint/${sprintId}`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({ state: 'closed' }),
          }
        );

        return { content: [{ type: 'text' as const, text: `Completed sprint ${sprintId}` }] };
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
