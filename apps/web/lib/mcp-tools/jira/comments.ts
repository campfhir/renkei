/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Comment tools for Jira MCP.
 * Manage issue comments and bulk comment operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, issueUrl, withPresentationHint } from '../common';
import { adfToMarkdown } from './adf';
import { previewToolMeta, RESULTS_LIST_URI } from '../widgets';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function registerCommentTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
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
      logger.debug('jira_list_comments invoked', {
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

        const response = await auth.fetch(
          granularJiraScopes('jira_list_comments', true),
          `/rest/api/3/issue/${issueKey}/comment`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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

  // ——— Interactive results (MCP Apps) ————————————————————————————————
  // The same comment list, rendered as a thread card instead of flat text —
  // author and timestamp per row, portal/internal visibility in the meta
  // line, and the issue itself one click away.
  server.registerTool(
    'jira_list_comments_preview',
    {
      title: 'Jira · Read — List comments, rendered as a thread',
      description:
        'List the comments on an issue and render them as an interactive thread card with an ' +
        '"Open in Jira" link. Prefer this over jira_list_comments when the user wants to READ ' +
        'the discussion; use jira_list_comments when you need the comment bodies to reason ' +
        'over. After calling, do not repeat the comments in your reply.',
      annotations: { readOnlyHint: true },
      _meta: previewToolMeta(RESULTS_LIST_URI),
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      try {
        const issueKey = typeof args.issueKey === 'string' ? args.issueKey : '';
        if (!issueKey) return errText('issueKey is required');

        const response = await auth.fetch(
          granularJiraScopes('jira_list_comments', true),
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const comments: any[] = Array.isArray(data.comments) ? data.comments : [];
        const rows = comments.map((c: any) => {
          const visibility =
            c.jsdPublic === false ? 'internal' : c.jsdPublic === true ? 'visible on portal' : '';
          const body = c.body ? adfToMarkdown(c.body) : '';
          const avatarUrl =
            typeof c.author?.avatarUrls?.['24x24'] === 'string' ? c.author.avatarUrls['24x24'] : '';
          return {
            title: c.author?.displayName || 'Unknown',
            ...(avatarUrl ? { avatarUrl } : {}),
            meta: new Date(c.created).toLocaleString() + (visibility ? ` · ${visibility}` : ''),
            body: body.length > 600 ? `${body.slice(0, 600)}…` : body,
          };
        });

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${comments.length} comment${comments.length === 1 ? '' : 's'} on ${issueKey} ` +
                `rendered on the thread card. Do not repeat them; the user reads them there.`,
            },
          ],
          structuredContent: {
            kind: 'results',
            title: `Comments on ${issueKey}`,
            links: [{ label: 'Open in Jira', url: issueUrl(context.siteUrl, issueKey) }],
            rows,
          },
        };
      } catch (error) {
        return errText(error instanceof Error ? error.message : String(error));
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
      logger.debug('jira_bulk_get_comments invoked', {
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

        const response = await auth.fetch(
          granularJiraScopes('jira_bulk_get_comments', true),
          '/rest/api/3/comment/list',
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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
