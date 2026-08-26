/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confluenceGet,
  confluencePost,
  confluencePut,
  confluenceDelete,
  values,
  textResult,
  errText,
  str,
  num,
  rec,
  type ConfluenceAccess,
} from './client';
import { actMeta } from '@renkei/tool-outcomes';
import { markdownToConfluenceBody, confluenceBodyToMarkdown, isBlankMarkdown } from './markdown';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { ConfluenceAuth } from './confluence-auth';

/**
 * The receipt for a page Confluence just handed back: its title, and an
 * absolute link to it.
 *
 * `_links.webui` is a SITE-RELATIVE path ('/spaces/ENG/pages/123/Title'),
 * which is useless on its own in a notification — a link has to survive
 * being clicked from an email or a toast. Confluence's v2 responses carry
 * `_links.base` alongside it for exactly this join. When either half is
 * missing the receipt simply carries no link rather than a broken one.
 */
export function pageReceipt(page: Record<string, unknown>): Record<string, unknown> {
  const links = rec(page._links);
  const base = str(links.base);
  const webui = str(links.webui);
  const title = str(page.title);
  return actMeta({
    ...(title ? { id: `“${title}”` } : {}),
    ...(base && webui ? { url: `${base}${webui}` } : {}),
  });
}

function pageLine(page: Record<string, unknown>): string {
  const version = rec(page.version);
  return (
    `${str(page.title) || '(untitled)'} — status: ${str(page.status) || 'current'}` +
    (str(page.spaceId) ? ` — space: ${str(page.spaceId)}` : '') +
    (typeof version.number === 'number' ? ` — v${version.number}` : '') +
    ` — id: ${str(page.id)}`
  );
}

interface PageForUpdate {
  id: string;
  status: string;
  spaceId: string;
  title: string;
  bodyValue: string;
  versionNumber: number;
}

/**
 * Confluence's v2 update endpoint wants the full page representation, not
 * a partial patch — title/body/status/spaceId/version are all required
 * even when only one is changing. Every mutating page tool below fetches
 * this baseline first, then overrides just the field it's changing.
 */
async function fetchPageForUpdate(
  context: MCPToolContext,
  access: ConfluenceAccess,
  pageId: string
): Promise<PageForUpdate | { error: string }> {
  const result = await confluenceGet(
    context,
    access,
    `/api/v2/pages/${encodeURIComponent(pageId)}?body-format=atlas_doc_format`
  );
  if (!result.ok) return { error: result.error };
  const page = result.body;
  const version = rec(page.version);
  const bodyValue =
    str(rec(rec(page.body).atlas_doc_format).value) ||
    JSON.stringify({ version: 1, type: 'doc', content: [] });
  return {
    id: str(page.id),
    status: str(page.status) || 'current',
    spaceId: str(page.spaceId),
    title: str(page.title),
    bodyValue,
    versionNumber: typeof version.number === 'number' ? version.number : 0,
  };
}

export async function registerPageTools(
  server: McpServer,
  context: MCPToolContext,
  auth: ConfluenceAuth
): Promise<void> {
  server.registerTool(
    'confluence_list_pages',
    {
      title: 'Confluence · Read — List pages',
      description:
        'List pages, optionally narrowed to one space or by title. Draft pages are not reliably ' +
        'returned here (a known Confluence API gap) — use confluence_list_drafts instead. Page ' +
        'ids feed confluence_get_page and every mutating page tool.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        spaceId: z.string().describe('Only pages in this space').optional(),
        title: z.string().describe('Exact title match').optional(),
        status: z
          .enum(['current', 'archived', 'trashed', 'historical'])
          .describe('Default: current')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [`limit=${max}`, `status=${str(args.status) || 'current'}`];
      if (str(args.spaceId)) parts.push(`space-id=${encodeURIComponent(str(args.spaceId))}`);
      if (str(args.title)) parts.push(`title=${encodeURIComponent(str(args.title))}`);
      const result = await confluenceGet(context, access, `/api/v2/pages?${parts.join('&')}`);
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(pageLine);
      if (lines.length === 0) return textResult('No pages.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Title, Status, Space, Version, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_get_page',
    {
      title: 'Confluence · Read — Get one page',
      description:
        'Fetch a page by id: title, status, space, author, version, and its body rendered as ' +
        'Markdown.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id from confluence_list_pages/confluence_search'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}?body-format=atlas_doc_format`
      );
      if (!result.ok) return errText(result.error);
      const page = result.body;
      const version = rec(page.version);
      const markdown = confluenceBodyToMarkdown(page.body);
      return textResult(
        `Title: ${str(page.title) || '(untitled)'}\n` +
          `Status: ${str(page.status) || 'current'}\n` +
          `Space id: ${str(page.spaceId)}\n` +
          `Parent id: ${str(page.parentId) || '(none — top-level)'}\n` +
          `Author id: ${str(page.authorId) || 'unknown'}\n` +
          `Version: ${num(version.number)} — by ${str(version.authorId) || 'unknown'} at ${str(version.createdAt)}\n\n` +
          (markdown || '(empty page)')
      );
    }
  );

  server.registerTool(
    'confluence_create_page',
    {
      title: 'Confluence · Act — Create a page',
      description:
        'Create a new Confluence page from Markdown. Headings, lists, code blocks, quotes, ' +
        'links, bold/italic/strike, and "[~accountId]" mentions (look up an accountId via ' +
        'confluence_search_users) all render properly in the Confluence editor.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        spaceId: z.string().min(1).describe('Space id from confluence_list_spaces'),
        title: z.string().min(1).describe('Page title'),
        markdown: z.string().describe('Page content, Markdown').optional(),
        parentId: z.string().describe('Create as a child of this page id').optional(),
        status: z
          .enum(['current', 'draft'])
          .describe('Publish immediately (current) or save as a draft (default: current)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const spaceId = str(args.spaceId);
      if (!spaceId) return errText('spaceId is required');
      const title = str(args.title);
      if (!title) return errText('title is required');
      const markdown = str(args.markdown);

      const result = await confluencePost(context, access, '/api/v2/pages', {
        spaceId,
        status: str(args.status) || 'current',
        title,
        ...(str(args.parentId) ? { parentId: str(args.parentId) } : {}),
        ...(isBlankMarkdown(markdown) ? {} : { body: markdownToConfluenceBody(markdown) }),
      });
      if (!result.ok) return errText(result.error);
      const page = result.body ?? {};
      return {
        ...textResult(
          `Created "${str(page.title) || title}" (id ${str(page.id) || 'unknown'}).` +
            (str(page.id) ? `\n[Open in Confluence](${str(rec(page._links).webui) || ''})` : '')
        ),
        _meta: pageReceipt(page),
      };
    }
  );

  server.registerTool(
    'confluence_update_page',
    {
      title: 'Confluence · Act — Edit a page',
      description:
        'Replace a page’s body with new Markdown content (a full replace, not a patch — Confluence ' +
        'has no partial-edit API). Optionally rename it in the same call. Use ' +
        'confluence_update_page_title for a rename with no content change.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id to edit'),
        markdown: z.string().min(1).describe('New page content, Markdown, replacing the old body'),
        title: z
          .string()
          .describe('New title (optional — omit to keep the current one)')
          .optional(),
        versionMessage: z.string().describe('Edit summary shown in page history').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const markdown = str(args.markdown);
      if (!markdown) return errText('markdown is required');

      const current = await fetchPageForUpdate(context, access, pageId);
      if ('error' in current) return errText(current.error);

      const result = await confluencePut(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}`,
        {
          id: current.id,
          status: current.status,
          spaceId: current.spaceId,
          title: str(args.title) || current.title,
          body: markdownToConfluenceBody(markdown),
          version: {
            number: current.versionNumber + 1,
            ...(str(args.versionMessage) ? { message: str(args.versionMessage) } : {}),
          },
        }
      );
      if (!result.ok) return errText(result.error);
      return {
        ...textResult(
          `Updated "${str(args.title) || current.title}" — now v${current.versionNumber + 1}.`
        ),
        // The PUT answers with the page it just wrote, links and all — so
        // an edit gets the same "open it" a creation does.
        _meta: pageReceipt(result.body ?? {}),
      };
    }
  );

  server.registerTool(
    'confluence_update_page_title',
    {
      title: 'Confluence · Act — Rename a page',
      description: 'Rename a page without touching its content.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id to rename'),
        title: z.string().min(1).describe('New title'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const title = str(args.title);
      if (!title) return errText('title is required');

      const current = await fetchPageForUpdate(context, access, pageId);
      if ('error' in current) return errText(current.error);

      const result = await confluencePut(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}`,
        {
          id: current.id,
          status: current.status,
          spaceId: current.spaceId,
          title,
          body: { representation: 'atlas_doc_format', value: current.bodyValue },
          version: { number: current.versionNumber + 1 },
        }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Renamed to "${title}".`);
    }
  );

  server.registerTool(
    'confluence_move_page',
    {
      title: 'Confluence · Act — Move a page to a different parent',
      description:
        'Change which page this one is nested under, within the same space. Reliable for ' +
        'ordinary page-to-page moves; Atlassian has documented edge cases moving a page under a ' +
        'database or folder specifically, so verify the result for those.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id to move'),
        newParentId: z.string().min(1).describe('The page id to nest it under'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const newParentId = str(args.newParentId);
      if (!newParentId) return errText('newParentId is required');

      const current = await fetchPageForUpdate(context, access, pageId);
      if ('error' in current) return errText(current.error);

      const result = await confluencePut(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}`,
        {
          id: current.id,
          status: current.status,
          spaceId: current.spaceId,
          title: current.title,
          parentId: newParentId,
          body: { representation: 'atlas_doc_format', value: current.bodyValue },
          version: { number: current.versionNumber + 1 },
        }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Moved "${current.title}" under page ${newParentId}.`);
    }
  );

  server.registerTool(
    'confluence_delete_page',
    {
      title: 'Confluence · Act — Delete (trash) a page',
      description:
        'Move a page to Trash — recoverable, same as deleting it from Confluence’s own UI. Call ' +
        'again with purge: true on an already-trashed page to erase it permanently (not ' +
        'recoverable).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id to delete'),
        purge: z.boolean().describe('Permanently erase an already-trashed page').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const purge = args.purge === true ? '?purge=true' : '';
      const result = await confluenceDelete(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}${purge}`
      );
      if (!result.ok) return errText(result.error);
      return textResult(purge ? 'Page permanently deleted.' : 'Page moved to Trash.');
    }
  );

  server.registerTool(
    'confluence_set_page_status',
    {
      title: 'Confluence · Act — Change a page’s status',
      description:
        'Set a page to current (published), draft, historical, or trashed. "archived" is ' +
        'deliberately not offered here — Confluence’s API currently accepts it but silently does ' +
        'nothing (an open Atlassian bug); use confluence_delete_page (trash) instead if the goal ' +
        'is to get a page out of active circulation.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id'),
        status: z.enum(['current', 'draft', 'historical', 'trashed']),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const status = str(args.status);
      if (!status) return errText('status is required');

      const current = await fetchPageForUpdate(context, access, pageId);
      if ('error' in current) return errText(current.error);

      const result = await confluencePut(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}`,
        {
          id: current.id,
          status,
          spaceId: current.spaceId,
          title: current.title,
          body: { representation: 'atlas_doc_format', value: current.bodyValue },
          version: { number: current.versionNumber + 1 },
        }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Status set to "${status}".`);
    }
  );

  server.registerTool(
    'confluence_list_page_versions',
    {
      title: 'Confluence · Read — List a page’s version history',
      description: 'Who edited a page and when, oldest first — for seeing authorship over time.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id'),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}/versions?limit=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (version) =>
          `v${num(version.number)} — ${str(version.authorId) || 'unknown'} at ${str(version.createdAt)}` +
          (str(version.message) ? ` — "${str(version.message)}"` : '')
      );
      if (lines.length === 0) return textResult('No version history.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Version, Author, Date, Message) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_list_drafts',
    {
      title: 'Confluence · Read — List my draft pages',
      description:
        'List the connected user’s own unpublished draft pages — a v1-only endpoint (Confluence’s ' +
        'v2 API cannot reliably list drafts, a known gap), and it only ever returns the caller’s ' +
        'own drafts, not everyone’s.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        spaceKey: z.string().describe('Narrow to one space by its key').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [`status=draft`, `limit=${max}`];
      if (str(args.spaceKey)) parts.push(`spaceKey=${encodeURIComponent(str(args.spaceKey))}`);
      const result = await confluenceGet(context, access, `/rest/api/content?${parts.join('&')}`);
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (draft) =>
          `${str(draft.title) || '(untitled)'} — type: ${str(draft.type)} — id: ${str(draft.id)}`
      );
      if (lines.length === 0) return textResult('No drafts.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Title, Type, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_get_page_properties',
    {
      title: 'Confluence · Read — Get a page’s custom metadata',
      description:
        'List arbitrary content-property metadata on a page — separate from its body, title, ' +
        'labels, or status.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}/properties?limit=50`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (property) => `${str(property.key)}: ${JSON.stringify(property.value)}`
      );
      return textResult(lines.length === 0 ? 'No custom metadata on this page.' : lines.join('\n'));
    }
  );

  server.registerTool(
    'confluence_set_page_property',
    {
      title: 'Confluence · Act — Set a page’s custom metadata',
      description:
        'Create or update one arbitrary content-property key/value pair on a page — for metadata ' +
        'that doesn’t belong in the body itself. The value may be any JSON-serializable data.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('Page id'),
        key: z.string().min(1).describe('Property key'),
        value: z.string().min(1).describe('Property value — a JSON string, or plain text'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId);
      if (!pageId) return errText('pageId is required');
      const key = str(args.key);
      if (!key) return errText('key is required');
      let value: unknown = str(args.value);
      try {
        value = JSON.parse(str(args.value));
      } catch {
        // Not JSON — store the raw string, same as a plain-text property value.
      }

      const existing = await confluenceGet(
        context,
        access,
        `/api/v2/pages/${encodeURIComponent(pageId)}/properties?key=${encodeURIComponent(key)}&limit=1`
      );
      const existingProperty = existing.ok ? values(existing.body)[0] : undefined;
      const existingVersion = existingProperty ? rec(existingProperty.version).number : undefined;
      const nextVersion = typeof existingVersion === 'number' ? existingVersion + 1 : 1;

      const result = existingProperty
        ? await confluencePut(
            context,
            access,
            `/api/v2/pages/${encodeURIComponent(pageId)}/properties/${encodeURIComponent(str(existingProperty.id))}`,
            {
              key,
              value,
              version: { number: nextVersion },
            }
          )
        : await confluencePost(
            context,
            access,
            `/api/v2/pages/${encodeURIComponent(pageId)}/properties`,
            {
              key,
              value,
            }
          );
      if (!result.ok) return errText(result.error);
      return textResult(`Set "${key}".`);
    }
  );
}
