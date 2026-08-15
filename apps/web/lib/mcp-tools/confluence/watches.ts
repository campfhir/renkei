/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Standing indexing instructions for Confluence spaces.
 *
 * Mirrors jira/watches.ts — same table, same per-user ownership, same live
 * permission re-check at read time. Confluence is the half of this that has
 * no alternative: Atlassian offers a plain OAuth app no webhook mechanism
 * for Confluence at all (it is a Connect-app module, with no REST route and
 * no scope), so polling a watched space is the only way its content stays
 * current.
 *
 * The watch is keyed by space **id**, not key, because that is what the v2
 * page listing filters on — but users think in keys, so both are accepted
 * and resolved here.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { ConfluenceAuth } from './confluence-auth';
import { confluenceGet, values, textResult, errText, str } from './client';
import { upsertWatch, disableWatch, listWatches, watchLine } from '../content-watches';
import type { ConfluenceAccess } from './client';

/** Resolve a space key OR id to its canonical id + name, or null. */
async function resolveSpace(
  context: MCPToolContext,
  access: ConfluenceAccess,
  input: string
): Promise<{ id: string; name: string } | null> {
  // v2 filters by key, so a key lookup is one call; an id that happens to
  // look like a key simply returns nothing and falls through.
  const byKey = await confluenceGet(
    context,
    access,
    `/api/v2/spaces?keys=${encodeURIComponent(input)}&limit=1`
  );
  if (byKey.ok) {
    const match = values(byKey.body)[0];
    if (match) return { id: str(match.id), name: str(match.name) || input };
  }
  if (!/^\d+$/.test(input)) return null;

  const byId = await confluenceGet(context, access, `/api/v2/spaces/${encodeURIComponent(input)}`);
  if (!byId.ok || !str(byId.body.id)) return null;
  return { id: str(byId.body.id), name: str(byId.body.name) || input };
}

export async function registerWatchTools(
  server: McpServer,
  context: MCPToolContext,
  auth: ConfluenceAuth
): Promise<void> {
  server.registerTool(
    'confluence_watch_space',
    {
      title: 'Confluence · Write — Watch a space for indexing',
      description:
        'Keep a Confluence space continuously indexed so its pages become searchable through ' +
        'search_knowledge by meaning rather than exact wording. Indexing runs in the background ' +
        'under your own Confluence access, and every result is re-checked against your live ' +
        'permissions when it is read, so watching never widens what anyone can see.',
      inputSchema: z.object({
        space: z.string().min(1).describe('Space key (e.g. ENG) or space id'),
      }),
    },
    async (args: Record<string, any>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const input = String(args.space ?? '').trim();
      if (!input) return errText('space is required');

      // Resolve before storing — an unresolvable key would otherwise become
      // a watch that fails silently in the background forever.
      const space = await resolveSpace(context, access, input);
      if (!space) {
        return errText(
          `No Confluence space "${input}" is visible to you. List them with confluence_list_spaces.`
        );
      }

      const result = await upsertWatch(
        { tenantId: context.tenantId, subject: context.subject, accountId: access.accountId },
        'confluence',
        'space',
        space.id,
        space.name
      );
      if (!result.ok) return errText(result.error);

      return textResult(
        result.created
          ? `Watching ${space.name} (space id ${space.id}). The first indexing pass starts within ` +
              'a few minutes; large spaces take a while to work through.'
          : `${space.name} was already being watched — nothing changed.`
      );
    }
  );

  server.registerTool(
    'confluence_unwatch_space',
    {
      title: 'Confluence · Write — Stop watching a space',
      description:
        'Stop indexing new changes in a Confluence space. Already-indexed pages stay searchable ' +
        '(they are permission-checked live on every read); this only stops the background ' +
        'polling. Re-watching later resumes where it left off rather than re-reading history.',
      inputSchema: z.object({
        space: z.string().min(1).describe('Space key (e.g. ENG) or space id'),
      }),
    },
    async (args: Record<string, any>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const input = String(args.space ?? '').trim();
      if (!input) return errText('space is required');

      const space = await resolveSpace(context, access, input);
      const scopeKey = space?.id ?? input;
      const result = await disableWatch(
        { tenantId: context.tenantId, subject: context.subject, accountId: access.accountId },
        'confluence',
        'space',
        scopeKey
      );
      if (!result.ok) return errText(result.error);
      return textResult(
        result.found
          ? `Stopped watching ${space?.name ?? scopeKey}.`
          : `You were not watching ${space?.name ?? input} — nothing to stop.`
      );
    }
  );

  server.registerTool(
    'confluence_list_watches',
    {
      title: 'Confluence · Read — List watched spaces',
      description:
        'Show which Confluence spaces you have set to be indexed, with how much has been indexed ' +
        'and when each last synced. Use this to check whether a space is actually being kept ' +
        'fresh before trusting a search_knowledge result to be complete.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const result = await listWatches(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'confluence'
      );
      if (!result.ok) return errText(result.error);
      if (result.watches.length === 0) {
        return textResult(
          'You are not watching any Confluence spaces. Add one with confluence_watch_space.'
        );
      }
      return textResult(
        [
          `Watched Confluence spaces (${result.watches.length}):`,
          ...result.watches.map(watchLine),
        ].join('\n• ')
      );
    }
  );
}
