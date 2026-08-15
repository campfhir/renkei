/**
 * SharePoint pages.
 *
 * Three things about this API are load-bearing and none of them are obvious:
 *
 * 1. A created or updated page is a DRAFT, invisible to everyone else until
 *    it is published. Microsoft's own documented response carries
 *    `publishingState.level: "checkout"`. This is the single most likely
 *    "the tool said it worked but nobody can see it" failure, so publishing
 *    is the default and there is a standalone publish tool.
 * 2. `@odata.type: "#microsoft.graph.sitePage"` must be in the request BODY.
 *    Without it Graph cannot tell which kind of page to create and rejects
 *    the call.
 * 3. Only text web parts can be authored this way. Graph accepts a short
 *    list of standard web part types and nothing else, so `create_page`
 *    builds a single column of text rather than pretending to reproduce an
 *    arbitrary layout.
 *
 * There is no summarize tool. `sharepoint_read_page` returns clean text and
 * the calling model summarizes it — a server-side summarizer would be a
 * worse copy of what the caller already does, with no idea what the user
 * actually asked.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import { withPresentationHint } from '../common';
import { htmlToDocumentText } from '@renkei/document-text';
import {
  graphGet,
  graphPost,
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

/** The cast segment Graph needs to treat a page as a sitePage. */
const PAGE_CAST = 'microsoft.graph.sitePage';

/**
 * Walk canvasLayout, pulling text out of text web parts and NAMING the ones
 * whose content cannot be extracted. Reporting what was skipped matters: a
 * model that silently summarizes half a page has no way to know it did.
 */
function readCanvas(body: Record<string, unknown>): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];

  const titleArea = rec(body.titleArea);
  if (str(titleArea.textAboveTitle)) parts.push(str(titleArea.textAboveTitle));

  const canvas = rec(body.canvasLayout);
  const sections = Array.isArray(canvas.horizontalSections) ? canvas.horizontalSections : [];
  for (const rawSection of sections) {
    const columns = Array.isArray(rec(rawSection).columns) ? rec(rawSection).columns : [];
    for (const rawColumn of Array.isArray(columns) ? columns : []) {
      const webparts = rec(rawColumn).webparts;
      for (const rawPart of Array.isArray(webparts) ? webparts : []) {
        const part = rec(rawPart);
        const html = str(part.innerHtml);
        if (html) {
          parts.push(htmlToDocumentText(html));
          continue;
        }
        const type = str(part.webPartType);
        if (type) skipped.push(type);
      }
    }
  }

  const vertical = rec(canvas.verticalSection);
  for (const rawPart of Array.isArray(vertical.webparts) ? vertical.webparts : []) {
    const part = rec(rawPart);
    const html = str(part.innerHtml);
    if (html) parts.push(htmlToDocumentText(html));
  }

  return { text: parts.filter(Boolean).join('\n\n'), skipped };
}

/** Build the canvas Graph accepts: one column of text web parts. */
function textCanvas(html: string): Record<string, unknown> {
  return {
    horizontalSections: [
      {
        layout: 'oneColumn',
        id: '1',
        emphasis: 'none',
        columns: [
          {
            id: '1',
            width: 12,
            webparts: [{ id: randomUUID(), innerHtml: html }],
          },
        ],
      },
    ],
  };
}

async function publishPage(
  context: MCPToolContext,
  token: string,
  siteId: string,
  pageId: string
): Promise<string | null> {
  const published = await graphPost(
    context,
    token,
    `/sites/${siteId}/pages/${pageId}/${PAGE_CAST}/publish`,
    undefined
  );
  return published.ok ? null : published.error;
}

export function registerPageTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): void {
  server.registerTool(
    'sharepoint_list_pages',
    {
      title: 'SharePoint · Read — List the pages on a site',
      description: 'Pages on a site, with the id sharepoint_read_page and the edit tools accept.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        max: z.number().int().min(1).max(100).describe('How many (default 50).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);

      const max = num(args.max) ?? 50;
      const listing = await graphGet(
        context,
        access.accessToken,
        `/sites/${resolved.siteId}/pages?$top=${max}` +
          '&$select=id,name,title,webUrl,pageLayout,lastModifiedDateTime'
      );
      if (!listing.ok) return errText(listing.error);

      const pages = values(listing.body);
      if (pages.length === 0) return textResult(`${resolved.name} has no pages.`);
      const lines = pages.map(
        (page) =>
          `${str(page.title) || str(page.name)}\n    ${str(page.webUrl)}\n    pageId: ${str(page.id)}`
      );
      return textResult(
        withPresentationHint(
          `${resolved.name} — ${pages.length} page(s)\n\n${lines.join('\n')}`,
          'Render as a list of pages.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_read_page',
    {
      title: 'SharePoint · Read — Read a page’s text (to summarize or quote it)',
      description:
        'The full text of a SharePoint page — its title and every text web part, as plain text ' +
        'ready to summarize or quote. Web parts that embed other content (file viewers, list ' +
        'views, news rollups) are listed by type rather than expanded, so you can tell what is ' +
        'on the page but not in this text. To change who can see a page, pass its URL to ' +
        'sharepoint_add_user_to_document — pages are files in the Site Pages library.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        pageId: z.string().min(1).describe('Page id, from sharepoint_list_pages.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);

      const page = await graphGet(
        context,
        access.accessToken,
        `/sites/${resolved.siteId}/pages/${encodeURIComponent(String(args.pageId))}/${PAGE_CAST}` +
          '?$expand=canvasLayout'
      );
      if (!page.ok) return errText(page.error);

      const { text, skipped } = readCanvas(page.body);
      const header = `${str(page.body.title) || str(page.body.name)}\n${str(page.body.webUrl)}`;
      const state = str(rec(page.body.publishingState).level);
      const draftNote = state && state !== 'published' ? `\n(This page is a ${state} draft.)` : '';
      const skippedNote = skipped.length
        ? `\n\nNot extracted — ${skipped.length} embedded web part(s): ${[...new Set(skipped)].join(', ')}`
        : '';

      if (!text) {
        return textResult(`${header}${draftNote}\n\nThis page has no readable text.${skippedNote}`);
      }
      return textResult(
        withPresentationHint(
          `${header}${draftNote}\n\n${text}${skippedNote}`,
          'Render as the page text; summarize it if the user asked for a summary.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_create_page',
    {
      title: 'SharePoint · Act — Create a page',
      description:
        'Create a page from HTML. The body becomes a single column of text — Graph can only ' +
        'author text web parts, so images, embeds and multi-column layouts are not reproducible ' +
        'here. Published by default; an unpublished page is a draft nobody else can see.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        title: z.string().min(1).describe('Page title.'),
        contentHtml: z.string().describe('Body as simple HTML, e.g. <p>…</p>.').optional(),
        name: z.string().describe('File name; defaults to the title, .aspx appended.').optional(),
        publish: z.boolean().describe('Publish immediately (default true).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);

      const rawName =
        str(args.name) ||
        String(args.title)
          .replace(/[^\w\- ]+/g, '')
          .trim();
      const name = rawName.toLowerCase().endsWith('.aspx') ? rawName : `${rawName}.aspx`;

      const created = await graphPost(
        context,
        access.accessToken,
        `/sites/${resolved.siteId}/pages`,
        {
          // Required in the body — Graph cannot infer the page kind without it.
          '@odata.type': '#microsoft.graph.sitePage',
          name,
          title: String(args.title),
          pageLayout: 'article',
          ...(str(args.contentHtml) ? { canvasLayout: textCanvas(str(args.contentHtml)) } : {}),
        }
      );
      if (!created.ok) return errText(created.error);

      const pageId = str(created.body.id);
      if (args.publish === false) {
        return textResult(
          `Created draft page "${String(args.title)}" (pageId: ${pageId}).\n` +
            'It is NOT visible to anyone else until published — use sharepoint_publish_page.'
        );
      }
      const failure = await publishPage(context, access.accessToken, resolved.siteId, pageId);
      if (failure) {
        return textResult(
          `Created page "${String(args.title)}" (pageId: ${pageId}), but publishing failed: ` +
            `${failure}\nIt exists as a draft nobody else can see yet.`
        );
      }
      return textResult(
        `Created and published "${String(args.title)}".\n${str(created.body.webUrl)}\npageId: ${pageId}`
      );
    }
  );

  server.registerTool(
    'sharepoint_update_page',
    {
      title: 'SharePoint · Act — Update a page',
      description:
        'Change a page’s title or body. Supplying contentHtml REPLACES the page body entirely — ' +
        'read the page first if you mean to keep any of it. Published by default; without ' +
        'publishing, the edit stays a draft others cannot see.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        pageId: z.string().min(1).describe('Page id.'),
        title: z.string().describe('New title.').optional(),
        contentHtml: z.string().describe('New body; REPLACES the existing body.').optional(),
        publish: z.boolean().describe('Publish after updating (default true).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!str(args.title) && !str(args.contentHtml)) {
        return errText('Give a title, contentHtml, or both.');
      }

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);
      const pageId = encodeURIComponent(String(args.pageId));

      const updated = await graphPatch(
        context,
        access.accessToken,
        `/sites/${resolved.siteId}/pages/${pageId}/${PAGE_CAST}`,
        {
          '@odata.type': '#microsoft.graph.sitePage',
          ...(str(args.title) ? { title: str(args.title) } : {}),
          ...(str(args.contentHtml) ? { canvasLayout: textCanvas(str(args.contentHtml)) } : {}),
        }
      );
      if (!updated.ok) return errText(updated.error);

      if (args.publish === false) {
        return textResult('Updated the page as a draft. Others still see the published version.');
      }
      const failure = await publishPage(
        context,
        access.accessToken,
        resolved.siteId,
        String(args.pageId)
      );
      return textResult(
        failure
          ? `Updated the page, but publishing failed: ${failure}\nThe change is still a draft.`
          : 'Updated and published the page.'
      );
    }
  );

  server.registerTool(
    'sharepoint_publish_page',
    {
      title: 'SharePoint · Act — Publish a draft page',
      description: 'Make a draft page visible to everyone who can reach the site.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        pageId: z.string().min(1).describe('Page id.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);

      const failure = await publishPage(
        context,
        access.accessToken,
        resolved.siteId,
        String(args.pageId)
      );
      return failure ? errText(failure) : textResult('Published the page.');
    }
  );

  server.registerTool(
    'sharepoint_delete_page',
    {
      title: 'SharePoint · Act — Delete a page',
      description: 'Delete a page from a site.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        pageId: z.string().min(1).describe('Page id.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);

      const deleted = await graphDelete(
        context,
        access.accessToken,
        `/sites/${resolved.siteId}/pages/${encodeURIComponent(String(args.pageId))}`
      );
      if (!deleted.ok) return errText(deleted.error);
      return textResult('Deleted the page.');
    }
  );
}
