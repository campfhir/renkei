/**
 * Designating a document library for indexing.
 *
 * The safety sentence in these descriptions is not boilerplate for
 * SharePoint the way it nearly is for Jira. Indexing runs under the watching
 * user's access, so a watch can never index what its owner could not read —
 * but a library is SHARED, so what the owner can read is not what every
 * reader may read. Disclosure is decided per reader at search time by the
 * live ACL gate, never by this row. Both halves matter and both are said.
 *
 * The library is resolved to a real driveId before the watch is stored, the
 * same discipline confluence/watches.ts applies to spaces: an unresolvable
 * scope would otherwise become a watch that fails silently in the background
 * forever.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { withPresentationHint } from '../common';
import { upsertWatch, disableWatch, listWatches, watchLine } from '../content-watches';
import { resolveGraphAccess, str, textResult, errText } from '../graph/client';
import { resolveLibrary, resolveSite } from '../graph/resolve';

const SAFETY =
  'Indexing runs under your own access, and every result is re-checked against the reader’s ' +
  'live permissions when it is read — so watching a library never widens what anyone can see.';

export function registerWatchTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'sharepoint_watch_library',
    {
      title: 'SharePoint · Act — Index a document library into knowledge',
      description:
        'Keep a document library indexed for semantic search, so its documents can be found by ' +
        `meaning rather than filename. ${SAFETY} Indexing starts within a few minutes; large ` +
        'libraries fill in over several rounds.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        library: z.string().describe('Library name; omit for the site default.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);
      if (!context.subject || !context.accountId) {
        return errText('No signed-in Microsoft identity on this request.');
      }

      const site = await resolveSite(context, access.accessToken, String(args.site));
      if (!site.ok) return errText(site.error);
      const library = await resolveLibrary(
        context,
        access.accessToken,
        String(args.site),
        str(args.library) || undefined
      );
      if (!library.ok) return errText(library.error);

      const label = `${site.name} / ${library.name}`;
      const result = await upsertWatch(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'sharepoint',
        'drive',
        library.driveId,
        label
      );
      if (!result.ok) return errText(result.error);
      return textResult(
        result.created
          ? `Now indexing "${label}". ${SAFETY}`
          : `"${label}" was already being indexed.`
      );
    }
  );

  server.registerTool(
    'sharepoint_unwatch_library',
    {
      title: 'SharePoint · Act — Stop indexing a document library',
      description:
        'Stop keeping a library fresh. Already-indexed documents stay searchable — they are ' +
        'still access-checked per reader — but new and changed files will not be picked up.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id.'),
        library: z.string().describe('Library name; omit for the site default.').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await resolveGraphAccess(context);
      if (typeof access === 'string') return errText(access);
      if (!context.subject || !context.accountId) {
        return errText('No signed-in Microsoft identity on this request.');
      }

      const library = await resolveLibrary(
        context,
        access.accessToken,
        String(args.site),
        str(args.library) || undefined
      );
      if (!library.ok) return errText(library.error);

      const result = await disableWatch(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'sharepoint',
        'drive',
        library.driveId
      );
      if (!result.ok) return errText(result.error);
      return textResult(
        result.found ? `Stopped indexing "${library.name}".` : 'That library was not being indexed.'
      );
    }
  );

  server.registerTool(
    'sharepoint_list_watches',
    {
      title: 'SharePoint · Read — List the libraries being indexed',
      description: 'Which document libraries you have set to be indexed, and how each is doing.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!context.subject || !context.accountId) {
        return errText('No signed-in Microsoft identity on this request.');
      }
      const result = await listWatches(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'sharepoint'
      );
      if (!result.ok) return errText(result.error);
      if (result.watches.length === 0) {
        return textResult('You are not indexing any SharePoint libraries.');
      }
      return textResult(
        withPresentationHint(
          result.watches.map(watchLine).join('\n'),
          'Render as a list with sync status.'
        )
      );
    }
  );
}
