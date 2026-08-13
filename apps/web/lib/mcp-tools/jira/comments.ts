/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Comment tools for Jira MCP.
 * Manage issue comments and bulk comment operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName, withPresentationHint } from '../common';
import { adfToMarkdown } from './adf';
import { logger } from '@/lib/logger';

export async function registerCommentTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // jira_list_comments
  server.registerTool(
    'jira_list_comments',
    {
      title: 'Jira · Read — List comments on an issue',
      description: 'List all comments on a specific issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_list_comments invoked', {
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
            // Comment bodies are ADF documents, not strings — .toString()
            // rendered every one as [object Object].
            const text = c.body ? adfToMarkdown(c.body) : '';
            const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
            // JSM projects stamp comments with jsdPublic — surfacing it makes
            // portal visibility verifiable without eyeballing the portal.
            const visibility =
              c.jsdPublic === false ? ' [internal]' : c.jsdPublic === true ? ' [portal]' : '';
            return `• ${author} (${date})${visibility} (ID: ${c.id}): ${clipped}`;
          }),
        ];

        if (comments.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a chronological comment-thread layout (author, timestamp, then body) usually ' +
                  'reads more naturally than this flat list.'
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

  // jira_bulk_get_comments
  server.registerTool(
    'jira_bulk_get_comments',
    {
      title: 'Jira · Read — Get comments in bulk',
      description: 'Fetch multiple comments by ID (efficient bulk retrieval for many comments).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        commentIds: z.array(z.string()).describe('List of comment IDs to fetch'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_bulk_get_comments invoked', {
        component: 'mcp/tool',
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
            // Comment bodies are ADF documents, not strings — .toString()
            // rendered every one as [object Object].
            const text = c.body ? adfToMarkdown(c.body) : '';
            const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
            // JSM projects stamp comments with jsdPublic — surfacing it makes
            // portal visibility verifiable without eyeballing the portal.
            const visibility =
              c.jsdPublic === false ? ' [internal]' : c.jsdPublic === true ? ' [portal]' : '';
            return `• ${author} (${date})${visibility} (ID: ${c.id}): ${clipped}`;
          }),
        ];

        if (comments.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a chronological comment-thread layout (author, timestamp, then body) usually ' +
                  'reads more naturally than this flat list.'
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
