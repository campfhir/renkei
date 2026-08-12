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
  num,
  rec,
  type ConfluenceAccess,
} from './client';
import { markdownToConfluenceBody, confluenceBodyToMarkdown, isBlankMarkdown } from './markdown';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';

function blogpostLine(post: Record<string, unknown>): string {
  const version = rec(post.version);
  return (
    `${str(post.title) || '(untitled)'} — status: ${str(post.status) || 'current'}` +
    (str(post.spaceId) ? ` — space: ${str(post.spaceId)}` : '') +
    (typeof version.number === 'number' ? ` — v${version.number}` : '') +
    ` — id: ${str(post.id)}`
  );
}

interface BlogpostForUpdate {
  id: string;
  status: string;
  spaceId: string;
  title: string;
  bodyValue: string;
  versionNumber: number;
}

async function fetchBlogpostForUpdate(
  context: MCPToolContext,
  access: ConfluenceAccess,
  blogpostId: string
): Promise<BlogpostForUpdate | { error: string }> {
  const result = await confluenceGet(
    context,
    access,
    `/api/v2/blogposts/${encodeURIComponent(blogpostId)}?body-format=atlas_doc_format`
  );
  if (!result.ok) return { error: result.error };
  const post = result.body;
  const version = rec(post.version);
  const bodyValue =
    str(rec(rec(post.body).atlas_doc_format).value) ||
    JSON.stringify({ version: 1, type: 'doc', content: [] });
  return {
    id: str(post.id),
    status: str(post.status) || 'current',
    spaceId: str(post.spaceId),
    title: str(post.title),
    bodyValue,
    versionNumber: typeof version.number === 'number' ? version.number : 0,
  };
}

export async function registerBlogpostTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'confluence_list_blogposts',
    {
      title: 'Confluence · Read — List blog posts',
      description: 'List blog posts, optionally narrowed to one space.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        spaceId: z.string().describe('Only blog posts in this space').optional(),
        status: z.enum(['current', 'trashed', 'draft']).describe('Default: current').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [`limit=${max}`, `status=${str(args.status) || 'current'}`];
      if (str(args.spaceId)) parts.push(`space-id=${encodeURIComponent(str(args.spaceId))}`);
      const result = await confluenceGet(context, access, `/api/v2/blogposts?${parts.join('&')}`);
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(blogpostLine);
      if (lines.length === 0) return textResult('No blog posts.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Title, Status, Space, Version, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_get_blogpost',
    {
      title: 'Confluence · Read — Get one blog post',
      description: 'Fetch a blog post by id, body rendered as Markdown.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        blogpostId: z.string().min(1).describe('Blog post id from confluence_list_blogposts'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const blogpostId = str(args.blogpostId);
      if (!blogpostId) return errText('blogpostId is required');
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/blogposts/${encodeURIComponent(blogpostId)}?body-format=atlas_doc_format`
      );
      if (!result.ok) return errText(result.error);
      const post = result.body;
      const version = rec(post.version);
      const markdown = confluenceBodyToMarkdown(post.body);
      return textResult(
        `Title: ${str(post.title) || '(untitled)'}\n` +
          `Status: ${str(post.status) || 'current'}\n` +
          `Space id: ${str(post.spaceId)}\n` +
          `Author id: ${str(post.authorId) || 'unknown'}\n` +
          `Version: ${num(version.number)} — by ${str(version.authorId) || 'unknown'} at ${str(version.createdAt)}\n\n` +
          (markdown || '(empty post)')
      );
    }
  );

  server.registerTool(
    'confluence_create_blogpost',
    {
      title: 'Confluence · Act — Create a blog post',
      description:
        'Create a new blog post from Markdown, same rendering rules as confluence_create_page.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        spaceId: z.string().min(1).describe('Space id'),
        title: z.string().min(1).describe('Post title'),
        markdown: z.string().describe('Post content, Markdown').optional(),
        status: z.enum(['current', 'draft']).describe('Default: current').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const spaceId = str(args.spaceId);
      if (!spaceId) return errText('spaceId is required');
      const title = str(args.title);
      if (!title) return errText('title is required');
      const markdown = str(args.markdown);

      const result = await confluencePost(context, access, '/api/v2/blogposts', {
        spaceId,
        status: str(args.status) || 'current',
        title,
        ...(isBlankMarkdown(markdown) ? {} : { body: markdownToConfluenceBody(markdown) }),
      });
      if (!result.ok) return errText(result.error);
      const post = result.body ?? {};
      return textResult(`Created "${str(post.title) || title}" (id ${str(post.id) || 'unknown'}).`);
    }
  );

  server.registerTool(
    'confluence_update_blogpost',
    {
      title: 'Confluence · Act — Edit a blog post',
      description:
        'Replace a blog post’s body with new Markdown (a full replace, same as confluence_update_page).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        blogpostId: z.string().min(1).describe('Blog post id'),
        markdown: z.string().min(1).describe('New content, Markdown'),
        title: z.string().describe('New title (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const blogpostId = str(args.blogpostId);
      if (!blogpostId) return errText('blogpostId is required');
      const markdown = str(args.markdown);
      if (!markdown) return errText('markdown is required');

      const current = await fetchBlogpostForUpdate(context, access, blogpostId);
      if ('error' in current) return errText(current.error);

      const result = await confluencePut(
        context,
        access,
        `/api/v2/blogposts/${encodeURIComponent(blogpostId)}`,
        {
          id: current.id,
          status: current.status,
          spaceId: current.spaceId,
          title: str(args.title) || current.title,
          body: markdownToConfluenceBody(markdown),
          version: { number: current.versionNumber + 1 },
        }
      );
      if (!result.ok) return errText(result.error);
      return textResult(
        `Updated "${str(args.title) || current.title}" — now v${current.versionNumber + 1}.`
      );
    }
  );

  server.registerTool(
    'confluence_delete_blogpost',
    {
      title: 'Confluence · Act — Delete (trash) a blog post',
      description:
        'Move a blog post to Trash — recoverable. Call again with purge: true on an ' +
        'already-trashed post to erase it permanently.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        blogpostId: z.string().min(1).describe('Blog post id'),
        purge: z.boolean().describe('Permanently erase an already-trashed post').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const blogpostId = str(args.blogpostId);
      if (!blogpostId) return errText('blogpostId is required');
      const purge = args.purge === true ? '?purge=true' : '';
      const result = await confluenceDelete(
        context,
        access,
        `/api/v2/blogposts/${encodeURIComponent(blogpostId)}${purge}`
      );
      if (!result.ok) return errText(result.error);
      return textResult(purge ? 'Blog post permanently deleted.' : 'Blog post moved to Trash.');
    }
  );
}
