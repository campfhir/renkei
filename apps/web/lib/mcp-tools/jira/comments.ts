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

/** How many comments one jira_list_comments call asks Jira for when the caller names no page size. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * One comment as the model reads it: a header line carrying the author, the
 * created timestamp exactly as Jira reports it (ISO 8601 with the UTC offset,
 * so no reader has to guess the zone), the portal/internal marker and the id
 * the edit and delete tools need — then the WHOLE body.
 *
 * The body is deliberately not clipped. These two tools are the ones the
 * preview card's description points at "when you need the comment bodies to
 * reason over", and a 300-character cut-off left every timeline, runbook and
 * pasted log unreadable past its first paragraph, with no tool left that
 * could fetch the rest.
 */
export function renderComment(c: any): string {
  const author = c.author?.displayName || 'Unknown';
  const created = typeof c.created === 'string' ? c.created : String(c.created ?? '');
  const edited =
    typeof c.updated === 'string' && c.updated !== c.created ? `, edited ${c.updated}` : '';
  // JSM projects stamp comments with jsdPublic — surfacing it makes
  // portal visibility verifiable without eyeballing the portal.
  const visibility =
    c.jsdPublic === false ? ' [internal]' : c.jsdPublic === true ? ' [portal]' : '';
  // Comment bodies are ADF documents, not strings — .toString()
  // rendered every one as [object Object].
  const body = c.body ? adfToMarkdown(c.body) : '';
  return `— ${author} (${created}${edited})${visibility} (ID: ${c.id})\n${body}`;
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
      description:
        'List the comments on an issue with their FULL bodies (nothing is truncated), oldest ' +
        'first, each with the comment id jira_update_comment and jira_delete_comment take. ' +
        'Long threads page: the reply says how many comments exist and how to fetch the rest.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        startAt: z
          .number()
          .int()
          .min(0)
          .describe('Index of the first comment to return (default 0) — for paging long threads')
          .optional(),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .describe(`Comments per page (1-${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE})`)
          .optional(),
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

        const startAt =
          typeof args.startAt === 'number' && args.startAt >= 0 ? Math.floor(args.startAt) : 0;
        const maxResults =
          typeof args.maxResults === 'number' && args.maxResults >= 1
            ? Math.min(Math.floor(args.maxResults), MAX_PAGE_SIZE)
            : DEFAULT_PAGE_SIZE;
        const query = new URLSearchParams({
          startAt: String(startAt),
          maxResults: String(maxResults),
          orderBy: 'created',
        });

        const response = await auth.fetch(
          granularJiraScopes('jira_list_comments', true),
          `/rest/api/3/issue/${encodeURIComponent(String(issueKey))}/comment?${query.toString()}`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const comments: any[] = Array.isArray(data.comments) ? data.comments : [];
        const total = typeof data.total === 'number' ? data.total : startAt + comments.length;

        if (comments.length === 0) {
          const text =
            total === 0
              ? `Issue ${issueKey} has no comments.`
              : `Issue ${issueKey} has ${total} comments, none at startAt=${startAt}.`;
          return { content: [{ type: 'text' as const, text }] };
        }

        const last = startAt + comments.length;
        const heading =
          total > comments.length
            ? `Issue ${issueKey} has ${total} comments; showing ${startAt + 1}–${last}` +
              (last < total ? ` (pass startAt=${last} for the next page)` : '') +
              ':'
            : `Issue ${issueKey} has ${comments.length} comment${comments.length === 1 ? '' : 's'}:`;
        const lines = [heading, ...comments.map((c) => renderComment(c))];

        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n\n'),
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
      description:
        'Fetch multiple comments by ID (efficient bulk retrieval for many comments). Bodies ' +
        'are returned in full.',
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
        const comments: any[] = Array.isArray(data.values) ? data.values : [];

        if (comments.length === 0) {
          return { content: [{ type: 'text' as const, text: 'Retrieved 0 comments.' }] };
        }
        const lines = [
          `Retrieved ${comments.length} comment${comments.length === 1 ? '' : 's'}:`,
          ...comments.map((c) => renderComment(c)),
        ];
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n\n'),
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
