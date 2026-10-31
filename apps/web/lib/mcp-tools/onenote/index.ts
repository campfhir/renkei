/**
 * The OneNote MCP namespace.
 *
 * A separate capability connector from OneDrive even though a notebook is,
 * physically, a folder in a drive: Graph's OneNote API is the only way to
 * read a page as text or write one (the `.one` files in the drive are
 * opaque), and "this person has OneNote" is a question about the Notes.*
 * scopes on their grant, not about a second connection (registry.ts,
 * `onenoteAvailable`).
 *
 * Nothing is indexed. Notebooks are personal or membership-scoped, so pages
 * are read live through the person's own grant — the Outlook rule — and
 * every write (a section, a page, an addition, a deletion) runs behind a
 * preview card; deleting a page is also on the agents' always-approve list.
 *
 * Where a notebook lives is one of three roots, chosen by the optional
 * `site` / `groupId` every tool accepts: the person's own (`/me/onenote`,
 * the default), a SharePoint site's (`/sites/{id}/onenote`) or a Microsoft
 * 365 group's (`/groups/{id}/onenote`, which is where a team's notebook
 * is). Page content is HTML in Graph's OneNote dialect; it is flattened to
 * text with the same helper the SharePoint page reader uses, and written
 * from Markdown through the same renderer the Outlook composer uses.
 *
 * How each call authenticates is an injected `GraphAuth` (graph/graph-auth.ts),
 * as for SharePoint and OneDrive.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuthedFetch } from '@renkei/delegate-client';
import { htmlToDocumentText } from '@renkei/document-text';
import type { MCPToolContext } from '../common';
import { withPresentationHint } from '../common';
import { withScopeGate } from '../capability-gate';
import type { GraphAuth } from '../graph/graph-auth';
import { registerOneNotePreviewLookups } from './preview-lookups';
import type { GraphCallContext } from '../graph/client';
import {
  graphGet,
  graphGetText,
  graphPost,
  graphPostText,
  graphPatch,
  graphDelete,
  values,
  str,
  num,
  rec,
  textResult,
  errText,
} from '../graph/client';
import { resolveSite } from '../graph/resolve';
import { markdownToHtml } from '../outlook/markdown';
import { logger } from '@/lib/logger';
import { onenoteScopeFor } from './scopes';

export const ONENOTE_MCP_CONNECTOR = 'onenote';

/** Graph's page-size ceiling for OneNote collections. */
const PAGE_MAX = 100;

/** The selector every tool takes for WHOSE notebooks: mine, a site's, a group's. */
const whereSchema = {
  site: z
    .string()
    .describe(
      'A SharePoint site URL or id, for notebooks kept on that site. Leave out for your own.'
    )
    .optional(),
  groupId: z
    .string()
    .describe('A Microsoft 365 group id, for a team’s shared notebook. Leave out for your own.')
    .optional(),
};

/** `/me/onenote`, `/sites/{id}/onenote` or `/groups/{id}/onenote`, resolved. */
async function rootOf(
  context: GraphCallContext,
  auth: AuthedFetch,
  args: Record<string, unknown>
): Promise<{ ok: true; root: string; where: string } | { ok: false; error: string }> {
  const site = str(args.site).trim();
  const groupId = str(args.groupId).trim();
  if (site && groupId) return { ok: false, error: 'Give site or groupId, not both.' };
  if (site) {
    const resolved = await resolveSite(context, auth, site);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      root: `/sites/${encodeURIComponent(resolved.siteId)}/onenote`,
      where: `site ${resolved.name || site}`,
    };
  }
  if (groupId) {
    return {
      ok: true,
      root: `/groups/${encodeURIComponent(groupId)}/onenote`,
      where: `group ${groupId}`,
    };
  }
  return { ok: true, root: '/me/onenote', where: 'your notebooks' };
}

function when(value: unknown): string {
  return str(value).slice(0, 10);
}

function webLink(entry: Record<string, unknown>): string {
  return str(rec(rec(entry.links).oneNoteWebUrl).href);
}

function notebookLine(notebook: Record<string, unknown>): string {
  const flags = [
    notebook.isDefault === true ? 'default' : '',
    notebook.isShared === true ? 'shared' : '',
  ].filter(Boolean);
  const link = webLink(notebook);
  return (
    `📓 ${str(notebook.displayName)}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}` +
    `${when(notebook.lastModifiedDateTime) ? `, modified ${when(notebook.lastModifiedDateTime)}` : ''}\n` +
    (link ? `    ${link}\n` : '') +
    `    notebookId: ${str(notebook.id)}`
  );
}

function sectionLine(section: Record<string, unknown>): string {
  const notebook = str(rec(section.parentNotebook).displayName);
  const group = str(rec(section.parentSectionGroup).displayName);
  const where = [notebook, group].filter(Boolean).join(' › ');
  return (
    `§ ${str(section.displayName)}${where ? ` — in ${where}` : ''}` +
    `${when(section.lastModifiedDateTime) ? `, modified ${when(section.lastModifiedDateTime)}` : ''}\n` +
    `    sectionId: ${str(section.id)}`
  );
}

function pageLine(page: Record<string, unknown>): string {
  const section = str(rec(page.parentSection).displayName);
  const link = webLink(page);
  return (
    `📄 ${str(page.title) || '(untitled)'}${section ? ` — in ${section}` : ''}` +
    `${when(page.lastModifiedDateTime) ? `, modified ${when(page.lastModifiedDateTime)}` : ''}\n` +
    (link ? `    ${link}\n` : '') +
    `    pageId: ${str(page.id)}`
  );
}

/** A OneNote page's HTML as a person reads it: its title, then its text. */
function pageText(html: string, maxChars: number): { title: string; text: string } {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  // Images and embedded files are placeholders in the text: their names
  // and alt text are what a reader can act on.
  const described = body
    .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, ' [image: $1] ')
    .replace(/<img\b[^>]*>/gi, ' [image] ')
    .replace(/<object\b[^>]*data-attachment="([^"]*)"[^>]*>[\s\S]*?<\/object>/gi, ' [file: $1] ');
  return { title, text: htmlToDocumentText(described, maxChars).trim() };
}

/** The HTML Graph wants for a new page: a document with a title and a body. */
function pageHtml(title: string, markdown: string): string {
  const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `<!DOCTYPE html><html><head><title>${escaped}</title>` +
    `<meta name="created" content="${new Date().toISOString()}" /></head>` +
    `<body>${markdownToHtml(markdown)}</body></html>`
  );
}

export async function registerOneNoteTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.graphScopes, (name) => onenoteScopeFor(name));
  registerOneNotePreviewLookups(context, auth);

  server.registerTool(
    'onenote_list_notebooks',
    {
      title: 'OneNote · Read — List notebooks',
      description:
        'The user’s OneNote notebooks (or a site’s or a group’s, when site/groupId is given), ' +
        'most recently changed first, with the notebookId the section tools take and a link to ' +
        'open each in OneNote.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ ...whereSchema }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      const result = await graphGet(
        context,
        access.auth,
        `${root.root}/notebooks?$orderby=lastModifiedDateTime desc&$top=${PAGE_MAX}`
      );
      if (!result.ok) return errText(result.error);
      const notebooks = values(result.body);
      if (notebooks.length === 0) return textResult(`No notebooks in ${root.where}.`);
      return textResult(
        withPresentationHint(
          `${notebooks.length} notebook(s) in ${root.where}\n\n${notebooks.map(notebookLine).join('\n')}`,
          'Render as a list of notebooks.'
        )
      );
    }
  );

  server.registerTool(
    'onenote_list_sections',
    {
      title: 'OneNote · Read — List sections',
      description:
        'The sections of one notebook (notebookId), or every section across the user’s ' +
        'notebooks when none is given — each with the notebook it belongs to and the sectionId ' +
        'the page tools take. Sections inside section groups are included.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        notebookId: z.string().describe('A notebook, from onenote_list_notebooks.').optional(),
        ...whereSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      const notebookId = str(args.notebookId).trim();
      const filter = notebookId
        ? `&$filter=parentNotebook/id eq '${notebookId.replace(/'/g, "''")}'`
        : '';
      const result = await graphGet(
        context,
        access.auth,
        `${root.root}/sections?$expand=parentNotebook,parentSectionGroup&$orderby=lastModifiedDateTime desc` +
          `&$top=${PAGE_MAX}${filter}`
      );
      if (!result.ok) return errText(result.error);
      const sections = values(result.body);
      if (sections.length === 0) {
        return textResult(notebookId ? 'This notebook has no sections.' : 'No sections found.');
      }
      return textResult(
        withPresentationHint(
          `${sections.length} section(s)\n\n${sections.map(sectionLine).join('\n')}`,
          'Render as a list of sections, grouped by notebook.'
        )
      );
    }
  );

  server.registerTool(
    'onenote_list_pages',
    {
      title: 'OneNote · Read — List or find pages',
      description:
        'Pages in one section (sectionId), or across every notebook when none is given, most ' +
        'recently changed first. Pass `title` to keep pages whose title contains those words. ' +
        'Each page carries the pageId onenote_read_page takes and a link to open it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sectionId: z.string().describe('A section, from onenote_list_sections.').optional(),
        title: z.string().describe('Words the page title must contain.').optional(),
        max: z.number().int().min(1).max(PAGE_MAX).describe('How many (default 25).').optional(),
        ...whereSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      const sectionId = str(args.sectionId).trim();
      const title = str(args.title).trim();
      const max = num(args.max) ?? 25;
      const path = sectionId
        ? `${root.root}/sections/${encodeURIComponent(sectionId)}/pages`
        : `${root.root}/pages`;
      const filter = title ? `&$filter=contains(title,'${title.replace(/'/g, "''")}')` : '';
      const result = await graphGet(
        context,
        access.auth,
        `${path}?$select=id,title,createdDateTime,lastModifiedDateTime,links&$expand=parentSection` +
          `&$orderby=lastModifiedDateTime desc&$top=${Math.min(PAGE_MAX, max)}${filter}`
      );
      if (!result.ok) return errText(result.error);
      const pages = values(result.body).slice(0, max);
      if (pages.length === 0) {
        return textResult(title ? `No page title contains "${title}".` : 'No pages found.');
      }
      return textResult(
        withPresentationHint(
          `${pages.length} page(s)\n\n${pages.map(pageLine).join('\n')}`,
          'Render as a list of pages, most recently changed first.'
        )
      );
    }
  );

  server.registerTool(
    'onenote_read_page',
    {
      title: 'OneNote · Read — Read a page’s text (to summarize or quote it)',
      description:
        'The full text of one OneNote page — its title and every paragraph, list and table as ' +
        'plain text ready to summarize or quote. Images and attached files are named in place. ' +
        'Take the pageId from onenote_list_pages.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('The page, from onenote_list_pages.'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .describe('Cut the text here (default 20000).')
          .optional(),
        ...whereSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const pageId = str(args.pageId).trim();
      if (!pageId) return errText('pageId is required.');
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      const result = await graphGetText(
        context,
        access.auth,
        `${root.root}/pages/${encodeURIComponent(pageId)}/content`
      );
      if (!result.ok) return errText(result.error);
      const { title, text } = pageText(result.text, num(args.maxChars) ?? 20_000);
      return textResult(
        withPresentationHint(
          `# ${title || '(untitled page)'}\n\n${text || '(The page has no text.)'}`,
          'Summarize or quote as the user asked; this is the whole page.'
        )
      );
    }
  );

  server.registerTool(
    'onenote_create_section',
    {
      title: 'OneNote · Act — Create a section',
      description: 'Add a new section to a notebook. The name must be unique in that notebook.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        notebookId: z.string().min(1).describe('The notebook, from onenote_list_notebooks.'),
        name: z.string().min(1).max(50).describe('The section’s name.'),
        ...whereSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const notebookId = str(args.notebookId).trim();
      const name = str(args.name).trim();
      if (!notebookId || !name) return errText('notebookId and name are required.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      const created = await graphPost(
        context,
        access.auth,
        `${root.root}/notebooks/${encodeURIComponent(notebookId)}/sections`,
        { displayName: name }
      );
      if (!created.ok) return errText(created.error);
      return textResult(
        `Created the section “${name}” (sectionId: ${str(created.body.id) || 'unknown'}).`
      );
    }
  );

  server.registerTool(
    'onenote_create_page',
    {
      title: 'OneNote · Act — Create a page',
      description:
        'Add a page to a section, with a title and a body in Markdown (headings, lists, links, ' +
        'tables, code). Only what the user asked to write down.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        sectionId: z.string().min(1).describe('The section, from onenote_list_sections.'),
        title: z.string().min(1).describe('The page title.'),
        markdown: z.string().describe('The page body, in Markdown.').optional(),
        ...whereSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const sectionId = str(args.sectionId).trim();
      const title = str(args.title).trim();
      if (!sectionId || !title) return errText('sectionId and title are required.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      const created = await graphPostText(
        context,
        access.auth,
        `${root.root}/sections/${encodeURIComponent(sectionId)}/pages`,
        pageHtml(title, str(args.markdown)),
        'text/html'
      );
      if (!created.ok) return errText(created.error);
      logger.info('onenote_create_page created', {
        component: 'mcp/tool',
        subject: context.subject,
        sectionId,
      });
      const link = webLink(created.body);
      return textResult(
        `Created the page “${title}” (pageId: ${str(created.body.id) || 'unknown'}).` +
          (link ? `\n${link}` : '')
      );
    }
  );

  server.registerTool(
    'onenote_append_to_page',
    {
      title: 'OneNote · Act — Add to a page',
      description:
        'Append Markdown to the end of an existing page (or put it at the top). Nothing already ' +
        'on the page is changed or removed.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('The page, from onenote_list_pages.'),
        markdown: z.string().min(1).describe('What to add, in Markdown.'),
        position: z
          .enum(['end', 'top'])
          .describe('Where on the page it goes (default end).')
          .optional(),
        ...whereSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const pageId = str(args.pageId).trim();
      const markdown = str(args.markdown);
      if (!pageId || !markdown.trim()) return errText('pageId and markdown are required.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      // Graph's OneNote PATCH is a list of edits against page elements;
      // `body` is the page's outline and append/prepend adds to it.
      const result = await graphPatch(
        context,
        access.auth,
        `${root.root}/pages/${encodeURIComponent(pageId)}/content`,
        [
          {
            target: 'body',
            action: str(args.position) === 'top' ? 'prepend' : 'append',
            content: markdownToHtml(markdown),
          },
        ]
      );
      if (!result.ok) return errText(result.error);
      return textResult(
        `Added to the page (${str(args.position) === 'top' ? 'at the top' : 'at the end'}).`
      );
    }
  );

  server.registerTool(
    'onenote_delete_page',
    {
      title: 'OneNote · Act — Delete a page',
      description:
        'Delete one page. OneNote keeps deleted pages in the notebook’s recycle bin for a time, ' +
        'but this tool cannot restore them — only on explicit request.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        pageId: z.string().min(1).describe('The page, from onenote_list_pages.'),
        ...whereSchema,
      }),
    },
    async (args: Record<string, unknown>) => {
      const pageId = str(args.pageId).trim();
      if (!pageId) return errText('pageId is required.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const root = await rootOf(context, access.auth, args);
      if (!root.ok) return errText(root.error);

      const result = await graphDelete(
        context,
        access.auth,
        `${root.root}/pages/${encodeURIComponent(pageId)}`
      );
      if (!result.ok) return errText(result.error);
      logger.info('onenote_delete_page deleted', {
        component: 'mcp/tool',
        subject: context.subject,
        pageId,
      });
      return textResult('Deleted the page.');
    }
  );
}
