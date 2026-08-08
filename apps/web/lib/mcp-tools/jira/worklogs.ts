/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Worklog (time tracking) tools for Jira MCP.
 * List, create, and manage time tracking entries on issues.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName, issueUrl } from '../common';
import { logger } from '@/lib/logger';

export async function registerWorklogTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // list_worklogs
  server.registerTool(
    'list_worklogs',
    {
      title: 'List worklogs on an issue',
      description: 'List all time tracking entries on a specific issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('list_worklogs invoked', {
        component: 'mcp/tool',
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

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/worklog`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const worklogs = data.worklogs || [];

        const lines = [
          `Issue ${issueKey} has ${worklogs.length} worklogs:`,
          ...worklogs.map((w: any) => {
            const author = w.author?.displayName || 'Unknown';
            const duration = w.timeSpent || 'N/A';
            const started = w.started ? new Date(w.started).toLocaleDateString() : 'N/A';
            return `• ${author}: ${duration} (${started})${w.comment ? ` - ${w.comment}` : ''}`;
          }),
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

  // create_worklog
  server.registerTool(
    'create_worklog',
    {
      title: 'Create a worklog entry',
      description: 'Log time spent on an issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        timeSpent: z
          .string()
          .describe('Time spent in Jira duration format, e.g. "2h", "30m", "1w 2d 4h"'),
        comment: z.string().describe('Optional comment about the work').optional(),
        started: z
          .string()
          .describe('Optional start time in ISO format, e.g. 2024-01-15T10:30:00.000+0000')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('create_worklog invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, timeSpent, comment, started } = args;

        if (!issueKey || !timeSpent) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'issueKey and timeSpent are required',
              },
            ],
            isError: true,
          };
        }

        const body: any = {
          timeSpent: timeSpent as string,
        };

        if (comment) {
          body.comment = comment as string;
        }
        if (started) {
          body.started = started as string;
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/worklog`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const worklog = (await response.json()) as any;

        const lines = [
          `Worklog created on ${issueKey}`,
          `Time: ${worklog.timeSpent}`,
          `Author: ${worklog.author?.displayName}`,
          `Issue: ${issueUrl(context.siteUrl, issueKey as string)}`,
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

  // delete_worklog
  server.registerTool(
    'delete_worklog',
    {
      title: 'Delete a worklog entry',
      description: 'Remove a time tracking entry from an issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        worklogId: z.string().describe('ID of the worklog entry to delete'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('delete_worklog invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, worklogId } = args;

        if (!issueKey || !worklogId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'issueKey and worklogId are required',
              },
            ],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/worklog/${worklogId}`,
          context.accessToken,
          { method: 'DELETE' }
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `Worklog ${worklogId} deleted from ${issueKey}`,
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
