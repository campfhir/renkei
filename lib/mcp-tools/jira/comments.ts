/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Comment tools for Jira MCP.
 * Manage issue comments and bulk comment operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerCommentTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // list_comments
  server.registerTool(
    'list_comments',
    {
      title: 'List comments on an issue',
      description: 'List all comments on a specific issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] list_comments invoked', {
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
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/comment`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const comments = data.comments || [];

        const lines = [
          `Issue ${issueKey} has ${comments.length} comments:`,
          ...comments.map((c: any) => {
            const author = c.author?.displayName || 'Unknown';
            const date = new Date(c.created).toLocaleString();
            const text = c.body ? c.body.toString().substring(0, 100) : '';
            return `• ${author} (${date}): ${text}...`;
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

  // bulk_get_comments
  server.registerTool(
    'bulk_get_comments',
    {
      title: 'Get comments in bulk',
      description: 'Fetch multiple comments by ID (efficient bulk retrieval for many comments).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        commentIds: z.array(z.string()).describe('List of comment IDs to fetch'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] bulk_get_comments invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { commentIds } = args;

        if (!commentIds || (Array.isArray(commentIds) && commentIds.length === 0)) {
          return {
            content: [{ type: 'text' as const, text: 'commentIds array is required' }],
            isError: true,
          };
        }

        const body = {
          ids: (commentIds as string[]).map((id) => parseInt(id, 10)),
        };

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/comment/list`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const data = (await response.json()) as any;
        const comments = data.values || [];

        const lines = [
          `Retrieved ${comments.length} comments:`,
          ...comments.map((c: any) => {
            const author = c.author?.displayName || 'Unknown';
            const date = new Date(c.created).toLocaleString();
            const text = c.body ? c.body.toString().substring(0, 100) : '';
            return `• ${author} (${date}): ${text}...`;
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
}
