/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Confluence's "database" content type — confirmed metadata-only via
 * research: title, space, parent, version. There is no API for the
 * database's actual rows/columns, so these three tools are the entire
 * surface; every description says so rather than implying more.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confluenceGet,
  confluencePost,
  confluenceDelete,
  resolveConfluenceAccess,
  textResult,
  errText,
  str,
} from './client';
import type { MCPToolContext } from '../common';

export async function registerDatabaseTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'confluence_create_database',
    {
      title: 'Confluence · Act — Create a database',
      description:
        'Create a Confluence "database" object — metadata only (title, space, parent). There is ' +
        'no API for its rows/columns; use it as a placeholder to be filled in through Confluence’s ' +
        'own UI, or to organize a space, not as a real data store from here.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        spaceId: z.string().min(1).describe('Space id'),
        title: z.string().min(1).describe('Database title'),
        parentId: z.string().describe('Parent page/folder id').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const spaceId = str(args.spaceId);
      if (!spaceId) return errText('spaceId is required');
      const title = str(args.title);
      if (!title) return errText('title is required');
      const result = await confluencePost(context, access, '/api/v2/databases', {
        spaceId,
        title,
        ...(str(args.parentId) ? { parentId: str(args.parentId) } : {}),
      });
      if (!result.ok) return errText(result.error);
      const database = result.body ?? {};
      return textResult(
        `Created "${str(database.title) || title}" (id ${str(database.id) || 'unknown'}).`
      );
    }
  );

  server.registerTool(
    'confluence_get_database',
    {
      title: 'Confluence · Read — Get a database',
      description:
        'Fetch a database’s title, space, and parent — metadata only, no row/column access.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        databaseId: z.string().min(1).describe('Database id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const databaseId = str(args.databaseId);
      if (!databaseId) return errText('databaseId is required');
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/databases/${encodeURIComponent(databaseId)}`
      );
      if (!result.ok) return errText(result.error);
      const database = result.body;
      return textResult(
        `${str(database.title) || '(untitled)'} — space: ${str(database.spaceId)}` +
          (str(database.parentId) ? ` — parent: ${str(database.parentId)}` : '') +
          ` — id: ${str(database.id)}`
      );
    }
  );

  server.registerTool(
    'confluence_delete_database',
    {
      title: 'Confluence · Act — Delete a database',
      description: 'Delete a database object.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        databaseId: z.string().min(1).describe('Database id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const databaseId = str(args.databaseId);
      if (!databaseId) return errText('databaseId is required');
      const result = await confluenceDelete(
        context,
        access,
        `/api/v2/databases/${encodeURIComponent(databaseId)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult('Database deleted.');
    }
  );
}
