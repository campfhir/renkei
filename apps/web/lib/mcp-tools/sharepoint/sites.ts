/**
 * Finding sites and what is in them.
 *
 * `sharepoint_list_site_navigation` does NOT return the configured quick
 * launch. Graph exposes no navigation resource at all — SharePoint's own
 * `_api/web/navigation` needs a token for the SharePoint resource audience,
 * which is a second OAuth resource and a separate project. What this returns
 * is a site map assembled from what Graph does expose, which is usually the
 * same destinations in a different order. The description says so, so the
 * model never claims to have read the real navigation.
 *
 * Site MEMBERSHIP is deliberately absent. The only delegated route to it is
 * the Microsoft 365 group behind a team site, which means
 * GroupMember.ReadWrite.All — a directory-wide grant that lets the holder
 * restructure any group in the tenant, and one whose blast radius reaches
 * Teams, the group mailbox and the group calendar rather than just the site.
 * That is far too much authority to hand every user of an MCP client for a
 * capability nobody asked for. Managing site access stays in SharePoint's
 * own admin surface, where it belongs.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { withPresentationHint } from '../common';
import {
  resolveGraphAccess,
  graphGet,
  values,
  str,
  num,
  textResult,
  errText,
} from '../graph/client';
import { resolveSite } from '../graph/resolve';

export function registerSiteTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'sharepoint_find_sites',
    {
      title: 'SharePoint · Read — Find sites by name',
      description:
        'Search SharePoint sites the user can reach. Returns each site id, which every other ' +
        'sharepoint_* tool accepts (a site URL works too).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Part of the site name.'),
        max: z.number().int().min(1).max(50).describe('How many (default 20).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);

      const max = num(args.max) ?? 20;
      const found = await graphGet(
        context,
        access.accessToken,
        `/sites?search=${encodeURIComponent(String(args.query))}&$top=${max}` +
          '&$select=id,displayName,webUrl,description'
      );
      if (!found.ok) return errText(found.error);

      const sites = values(found.body);
      if (sites.length === 0) return textResult(`No SharePoint site matched "${args.query}".`);
      const lines = sites.map(
        (site) =>
          `${str(site.displayName)}\n    ${str(site.webUrl)}\n    id: ${str(site.id)}` +
          (str(site.description) ? `\n    ${str(site.description)}` : '')
      );
      return textResult(
        withPresentationHint(
          `${sites.length} site(s)\n\n${lines.join('\n')}`,
          'Render as a list of sites with links.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_list_libraries',
    {
      title: 'SharePoint · Read — List a site’s document libraries',
      description:
        'The document libraries on a site, with the driveId each document tool accepts. Start ' +
        'here when you know the site but not the library.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);

      const drives = await graphGet(
        context,
        access.accessToken,
        `/sites/${resolved.siteId}/drives?$select=id,name,webUrl,driveType`
      );
      if (!drives.ok) return errText(drives.error);

      const libraries = values(drives.body);
      if (libraries.length === 0) return textResult(`${resolved.name} has no document libraries.`);
      const lines = libraries.map(
        (drive) => `${str(drive.name)}\n    ${str(drive.webUrl)}\n    driveId: ${str(drive.id)}`
      );
      return textResult(
        withPresentationHint(
          `${resolved.name} — ${libraries.length} librar(ies)\n\n${lines.join('\n')}`,
          'Render as a list.'
        )
      );
    }
  );

  server.registerTool(
    'sharepoint_list_site_navigation',
    {
      title: 'SharePoint · Read — Map what is on a site',
      description:
        'Graph does not expose a SharePoint site’s configured navigation (quick launch or top ' +
        'nav) — there is no API for it. This returns a site map assembled from the site’s ' +
        'subsites, document libraries, lists and published pages: usually the same destinations, ' +
        'but in discovery order rather than the order an owner arranged them.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);

      const resolved = await resolveSite(context, access.accessToken, String(args.site));
      if (!resolved.ok) return errText(resolved.error);
      const base = `/sites/${resolved.siteId}`;

      const [subsites, drives, lists, pages] = await Promise.all([
        graphGet(context, access.accessToken, `${base}/sites?$select=id,displayName,webUrl`),
        graphGet(context, access.accessToken, `${base}/drives?$select=id,name,webUrl`),
        graphGet(context, access.accessToken, `${base}/lists?$select=id,displayName,webUrl,list`),
        graphGet(context, access.accessToken, `${base}/pages?$select=id,title,webUrl`),
      ]);

      const sections: string[] = [];
      const section = (
        label: string,
        result: typeof subsites,
        render: (e: Record<string, unknown>) => string
      ) => {
        if (!result.ok) return;
        const entries = values(result.body);
        if (entries.length === 0) return;
        sections.push(`${label}\n${entries.map((entry) => `  • ${render(entry)}`).join('\n')}`);
      };

      section('Subsites', subsites, (e) => `${str(e.displayName)} — ${str(e.webUrl)}`);
      section('Document libraries', drives, (e) => `${str(e.name)} — driveId: ${str(e.id)}`);
      section('Lists', lists, (e) => `${str(e.displayName)}`);
      section('Pages', pages, (e) => `${str(e.title)} — pageId: ${str(e.id)}`);

      if (sections.length === 0) return textResult(`${resolved.name} appears to be empty.`);
      return textResult(
        withPresentationHint(
          `${resolved.name}\n\n${sections.join('\n\n')}`,
          'Render as a grouped outline of the site.'
        )
      );
    }
  );
}
