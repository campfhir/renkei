/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Full-text search and user lookup — both v1-only. Confluence's v2 API has
 * no search endpoint at all (confirmed against the docs, not assumed), so
 * these are the one place this connector deliberately calls
 * /wiki/rest/api/... instead of /wiki/api/v2/....
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confluenceGet,
  resolveConfluenceAccess,
  values,
  textResult,
  errText,
  str,
  rec,
} from './client';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';

/** Wraps a bare word/phrase in CQL text-search syntax; passes a caller-supplied CQL clause through untouched. */
function cqlOf(query: string, looksLikeCql: boolean): string {
  return looksLikeCql ? query : `text ~ "${query.replace(/"/g, '\\"')}"`;
}

function searchResultLine(entry: Record<string, unknown>): string {
  const content = rec(entry.content);
  const space = rec(content.space);
  return (
    `[${str(content.type) || str(entry.entityType) || '?'}] ${str(entry.title) || str(content.title) || '(untitled)'}` +
    (str(space.key) ? ` — space: ${str(space.key)}` : '') +
    ` — id: ${str(content.id)}` +
    (str(entry.excerpt) ? `\n  ${str(entry.excerpt).replace(/\n/g, '\n  ')}` : '')
  );
}

export async function registerSearchTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'confluence_search',
    {
      title: 'Confluence · Read — Search pages, blog posts & attachments',
      description:
        'Full-text search across Confluence. Pass plain text for a simple match, or a full CQL ' +
        'clause (e.g. \'space = "ENG" AND type = page\') when you need to filter precisely — set ' +
        'cql: true when doing so. Result ids feed confluence_get_page/confluence_get_blogpost.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Search text, or a CQL clause when cql is true'),
        cql: z.boolean().describe('Treat query as a raw CQL clause (default false)').optional(),
        max: z.number().int().min(1).max(50).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const query = str(args.query);
      if (!query) return errText('query is required');
      const max = typeof args.max === 'number' ? args.max : 20;
      const cql = cqlOf(query, args.cql === true);
      const result = await confluenceGet(
        context,
        access,
        `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(searchResultLine);
      if (lines.length === 0) return textResult('No matches.');
      return textResult(
        withPresentationHint(
          lines.join('\n\n'),
          'a table (Title, Space, Type, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_search_users',
    {
      title: 'Confluence · Read — Search users',
      description:
        'Look up people by name for @-mentioning them in a page/comment (confluence_create_page/' +
        'confluence_update_page/confluence_add_comment accept "[~accountId]" in the Markdown body ' +
        'to insert a real mention) or for cross-referencing page authorship.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Name fragment to search for'),
        max: z.number().int().min(1).max(50).describe('How many (default 15)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const query = str(args.query).replace(/"/g, '\\"');
      if (!query) return errText('query is required');
      const max = typeof args.max === 'number' ? args.max : 15;
      const cql = `user.fullname ~ "${query}"`;
      const result = await confluenceGet(
        context,
        access,
        `/rest/api/search/user?cql=${encodeURIComponent(cql)}&limit=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((entry) => {
        const user = rec(entry.user);
        return `${str(user.displayName) || str(entry.title) || '(unnamed)'} — accountId: ${str(user.accountId)}`;
      });
      if (lines.length === 0) return textResult('No matching users.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Name, accountId) usually scans faster than this flat list.'
        )
      );
    }
  );
}
