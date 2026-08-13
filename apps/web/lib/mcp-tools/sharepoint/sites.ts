/**
 * Finding sites and what is in them, plus the site-membership tools.
 *
 * Two honest limits are baked into the names here:
 *
 * `sharepoint_list_site_navigation` does NOT return the configured quick
 * launch. Graph exposes no navigation resource at all — SharePoint's own
 * `_api/web/navigation` needs a token for the SharePoint resource audience,
 * which is a second OAuth resource and a separate project. What this returns
 * is a site map assembled from what Graph does expose, which is usually the
 * same destinations in a different order. The description says so, so the
 * model never claims to have read the real navigation.
 *
 * The membership tools are named `*_site_member` rather than
 * `update_site_access` because that is what they actually do:
 * `/sites/{id}/permissions` is application-only, so the sole delegated route
 * to site access is the Microsoft 365 group behind a team site. A tool
 * promising "site access" would be reached for on a communication site and
 * fail confusingly.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { withPresentationHint } from '../common';
import {
  resolveGraphAccess,
  graphGet,
  graphPost,
  graphDelete,
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

  server.registerTool(
    'sharepoint_list_site_members',
    {
      title: 'SharePoint · Read — List who can reach a team site',
      description:
        'Members and owners of the Microsoft 365 group behind a team site. Only group-connected ' +
        'team sites work this way — communication sites and classic SharePoint groups are not ' +
        'visible through Graph at all. Needs the Groups scope.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        groupId: z.string().min(1).describe('The Microsoft 365 group id behind the site.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);
      const groupId = encodeURIComponent(String(args.groupId));

      const [members, owners] = await Promise.all([
        graphGet(
          context,
          access.accessToken,
          `/groups/${groupId}/members?$select=id,displayName,mail`
        ),
        graphGet(
          context,
          access.accessToken,
          `/groups/${groupId}/owners?$select=id,displayName,mail`
        ),
      ]);
      if (!members.ok) return errText(members.error);

      const render = (entry: Record<string, unknown>) =>
        `${str(entry.displayName)}${str(entry.mail) ? ` <${str(entry.mail)}>` : ''}`;
      const lines = [
        `Owners\n${
          values(owners.ok ? owners.body : {})
            .map((o) => `  • ${render(o)}`)
            .join('\n') || '  (none visible)'
        }`,
      ];
      lines.push(
        `Members\n${
          values(members.body)
            .map((m) => `  • ${render(m)}`)
            .join('\n') || '  (none)'
        }`
      );
      return textResult(withPresentationHint(lines.join('\n\n'), 'Render as two lists.'));
    }
  );

  server.registerTool(
    'sharepoint_add_site_member',
    {
      title: 'SharePoint · Act — Add someone to a team site',
      description:
        'Add a person to the Microsoft 365 group behind a team site, which is the only ' +
        'delegated way to grant site access. THIS CHANGES THE GROUP EVERYWHERE IT IS USED — ' +
        'its Teams team, its mailbox and its calendar — not only the site.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        groupId: z.string().min(1).describe('The Microsoft 365 group id behind the site.'),
        userId: z.string().min(1).describe('Directory id of the user to add.'),
        asOwner: z.boolean().describe('Add as an owner rather than a member.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);

      const collection = args.asOwner === true ? 'owners' : 'members';
      const added = await graphPost(
        context,
        access.accessToken,
        `/groups/${encodeURIComponent(String(args.groupId))}/${collection}/$ref`,
        {
          '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${String(args.userId)}`,
        }
      );
      if (!added.ok) return errText(added.error);
      return textResult(
        `Added the user as a ${collection === 'owners' ? 'owner' : 'member'} of the group. ` +
          'This affects the whole group — Teams, mailbox and calendar included.'
      );
    }
  );

  server.registerTool(
    'sharepoint_remove_site_member',
    {
      title: 'SharePoint · Act — Remove someone from a team site',
      description:
        'Remove a person from the Microsoft 365 group behind a team site. Same blast radius as ' +
        'adding: it affects the group everywhere, not only the site.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        groupId: z.string().min(1).describe('The Microsoft 365 group id behind the site.'),
        userId: z.string().min(1).describe('Directory id of the user to remove.'),
        asOwner: z.boolean().describe('Remove from owners rather than members.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);

      const collection = args.asOwner === true ? 'owners' : 'members';
      const removed = await graphDelete(
        context,
        access.accessToken,
        `/groups/${encodeURIComponent(String(args.groupId))}/${collection}/${encodeURIComponent(String(args.userId))}/$ref`
      );
      if (!removed.ok) return errText(removed.error);
      return textResult(`Removed the user from the group's ${collection}.`);
    }
  );
}
