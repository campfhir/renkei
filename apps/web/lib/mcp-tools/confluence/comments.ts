/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confluenceGet,
  confluencePost,
  confluencePut,
  confluenceDelete,
  resolveConfluenceAccess,
  values,
  textResult,
  errText,
  str,
  rec,
} from './client';
import { markdownToConfluenceBody, confluenceBodyToMarkdown } from './markdown';
import type { MCPToolContext } from '../common';

const CONTENT_TYPE_KEY: Record<string, string> = { page: 'pageId', blogpost: 'blogPostId' };
const KIND_PATH: Record<string, string> = {
  footer: 'footer-comments',
  inline: 'inline-comments',
};

function commentLine(comment: Record<string, unknown>): string {
  const version = rec(comment.version);
  const markdown = confluenceBodyToMarkdown(comment.body);
  return (
    `[${str(version.authorId) || 'unknown'} at ${str(version.createdAt)}] id: ${str(comment.id)}` +
    (str(comment.parentCommentId) ? ` (reply to ${str(comment.parentCommentId)})` : '') +
    `\n  ${markdown.replace(/\n/g, '\n  ')}`
  );
}

export async function registerCommentTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'confluence_list_comments',
    {
      title: 'Confluence · Read — List comments on a page or blog post',
      description:
        'List footer comments (the normal comment thread at the bottom) or inline comments ' +
        '(anchored to a text selection) on a page or blog post.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page or blog post id'),
        contentType: z.enum(['page', 'blogpost']),
        kind: z.enum(['footer', 'inline']).describe('Default: footer').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');
      const idKey = CONTENT_TYPE_KEY[str(args.contentType)];
      if (!idKey) return errText('contentType must be one of page, blogpost');
      const path = KIND_PATH[str(args.kind) || 'footer'];
      const max = typeof args.max === 'number' ? args.max : 25;
      const containerPath = idKey === 'pageId' ? 'pages' : 'blogposts';
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/${containerPath}/${encodeURIComponent(contentId)}/${path}?body-format=atlas_doc_format&limit=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(commentLine);
      return textResult(lines.length === 0 ? 'No comments.' : lines.join('\n\n'));
    }
  );

  server.registerTool(
    'confluence_add_comment',
    {
      title: 'Confluence · Act — Add a comment',
      description:
        'Add a footer comment (optionally a threaded reply via parentCommentId) or an inline ' +
        'comment anchored to a text selection (inlineAnchorText — must match text actually in ' +
        'the page/blog post body) to a page or blog post.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page or blog post id'),
        contentType: z.enum(['page', 'blogpost']),
        markdown: z.string().min(1).describe('Comment body, Markdown'),
        kind: z.enum(['footer', 'inline']).describe('Default: footer').optional(),
        parentCommentId: z.string().describe('Reply to this footer comment').optional(),
        inlineAnchorText: z
          .string()
          .describe('The exact text to anchor an inline comment to — required when kind is inline')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');
      const idKey = CONTENT_TYPE_KEY[str(args.contentType)];
      if (!idKey) return errText('contentType must be one of page, blogpost');
      const markdown = str(args.markdown);
      if (!markdown) return errText('markdown is required');
      const kind = str(args.kind) || 'footer';
      const path = KIND_PATH[kind];

      const payload: Record<string, unknown> = {
        [idKey]: contentId,
        body: markdownToConfluenceBody(markdown),
      };
      if (kind === 'footer' && str(args.parentCommentId)) {
        payload.parentCommentId = str(args.parentCommentId);
      }
      if (kind === 'inline') {
        const anchor = str(args.inlineAnchorText);
        if (!anchor) return errText('inlineAnchorText is required for an inline comment');
        payload.inlineCommentProperties = { textSelection: anchor };
      }

      const result = await confluencePost(context, access, `/api/v2/${path}`, payload);
      if (!result.ok) return errText(result.error);
      const comment = result.body ?? {};
      return textResult(`Comment added (id ${str(comment.id) || 'unknown'}).`);
    }
  );

  server.registerTool(
    'confluence_update_comment',
    {
      title: 'Confluence · Act — Edit a comment',
      description: 'Replace a comment’s body with new Markdown.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        commentId: z.string().min(1).describe('Comment id'),
        kind: z.enum(['footer', 'inline']).describe('Default: footer').optional(),
        markdown: z.string().min(1).describe('New comment body, Markdown'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const commentId = str(args.commentId);
      if (!commentId) return errText('commentId is required');
      const markdown = str(args.markdown);
      if (!markdown) return errText('markdown is required');
      const path = KIND_PATH[str(args.kind) || 'footer'];

      const current = await confluenceGet(
        context,
        access,
        `/api/v2/${path}/${encodeURIComponent(commentId)}`
      );
      if (!current.ok) return errText(current.error);
      const version = rec(current.body.version);
      const versionNumber = typeof version.number === 'number' ? version.number : 0;

      const result = await confluencePut(
        context,
        access,
        `/api/v2/${path}/${encodeURIComponent(commentId)}`,
        {
          version: { number: versionNumber + 1 },
          body: markdownToConfluenceBody(markdown),
        }
      );
      if (!result.ok) return errText(result.error);
      return textResult('Comment updated.');
    }
  );

  server.registerTool(
    'confluence_delete_comment',
    {
      title: 'Confluence · Act — Delete a comment',
      description: 'Remove a comment.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        commentId: z.string().min(1).describe('Comment id'),
        kind: z.enum(['footer', 'inline']).describe('Default: footer').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const commentId = str(args.commentId);
      if (!commentId) return errText('commentId is required');
      const path = KIND_PATH[str(args.kind) || 'footer'];
      const result = await confluenceDelete(
        context,
        access,
        `/api/v2/${path}/${encodeURIComponent(commentId)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult('Comment deleted.');
    }
  );
}
