/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Labels: v2 for listing (documented, read-heavy), v1 for add/remove.
 * Confluence's v2 API docs don't clearly confirm label mutation exists
 * there, so this uses v1's content-label endpoint — well-established,
 * and (unlike search/upload) works uniformly across pages, blog posts,
 * and attachments via v1's generic "content" resource.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confluenceGet,
  confluencePost,
  confluenceDelete,
  values,
  textResult,
  errText,
  str,
} from './client';
import type { MCPToolContext } from '../common';
import type { ConfluenceAuth } from './confluence-auth';

const CONTENT_TYPE_PATH: Record<string, string> = {
  page: 'pages',
  blogpost: 'blogposts',
  attachment: 'attachments',
};

export async function registerLabelTools(
  server: McpServer,
  context: MCPToolContext,
  auth: ConfluenceAuth
): Promise<void> {
  server.registerTool(
    'confluence_list_labels',
    {
      title: 'Confluence · Read — List labels on a page, blog post, or attachment',
      description: 'List the labels attached to a piece of content.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page, blog post, or attachment id'),
        contentType: z.enum(['page', 'blogpost', 'attachment']),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');
      const path = CONTENT_TYPE_PATH[str(args.contentType)];
      if (!path) return errText('contentType must be one of page, blogpost, attachment');
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/${path}/${encodeURIComponent(contentId)}/labels?limit=50`
      );
      if (!result.ok) return errText(result.error);
      const labels = values(result.body)
        .map((label) => str(label.name))
        .filter(Boolean);
      return textResult(labels.length === 0 ? 'No labels.' : labels.join(', '));
    }
  );

  server.registerTool(
    'confluence_add_label',
    {
      title: 'Confluence · Act — Add a label',
      description: 'Add a label to a page, blog post, or attachment.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page, blog post, or attachment id'),
        label: z.string().min(1).describe('Label name'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');
      const label = str(args.label);
      if (!label) return errText('label is required');
      const result = await confluencePost(
        context,
        access,
        `/rest/api/content/${encodeURIComponent(contentId)}/label`,
        [{ prefix: 'global', name: label }]
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Added label "${label}".`);
    }
  );

  server.registerTool(
    'confluence_remove_label',
    {
      title: 'Confluence · Act — Remove a label',
      description: 'Remove a label from a page, blog post, or attachment.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page, blog post, or attachment id'),
        label: z.string().min(1).describe('Label name'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');
      const label = str(args.label);
      if (!label) return errText('label is required');
      const result = await confluenceDelete(
        context,
        access,
        `/rest/api/content/${encodeURIComponent(contentId)}/label/${encodeURIComponent(label)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Removed label "${label}".`);
    }
  );
}
