/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Confluence's "whiteboard" content type — confirmed metadata-only via
 * research: title, space, parent, version. There is no API for the
 * actual canvas/drawing content, so these three tools are the entire
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

export async function registerWhiteboardTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'confluence_create_whiteboard',
    {
      title: 'Confluence · Act — Create a whiteboard',
      description:
        'Create a Confluence whiteboard object — metadata only (title, space, parent). There is ' +
        'no API for its canvas/drawing content; the board itself has to be filled in through ' +
        'Confluence’s own UI.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        spaceId: z.string().min(1).describe('Space id'),
        title: z.string().min(1).describe('Whiteboard title'),
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
      const result = await confluencePost(context, access, '/api/v2/whiteboards', {
        spaceId,
        title,
        ...(str(args.parentId) ? { parentId: str(args.parentId) } : {}),
      });
      if (!result.ok) return errText(result.error);
      const whiteboard = result.body ?? {};
      return textResult(
        `Created "${str(whiteboard.title) || title}" (id ${str(whiteboard.id) || 'unknown'}).`
      );
    }
  );

  server.registerTool(
    'confluence_get_whiteboard',
    {
      title: 'Confluence · Read — Get a whiteboard',
      description:
        'Fetch a whiteboard’s title, space, and parent — metadata only, no canvas access.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        whiteboardId: z.string().min(1).describe('Whiteboard id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const whiteboardId = str(args.whiteboardId);
      if (!whiteboardId) return errText('whiteboardId is required');
      const result = await confluenceGet(
        context,
        access,
        `/api/v2/whiteboards/${encodeURIComponent(whiteboardId)}`
      );
      if (!result.ok) return errText(result.error);
      const whiteboard = result.body;
      return textResult(
        `${str(whiteboard.title) || '(untitled)'} — space: ${str(whiteboard.spaceId)}` +
          (str(whiteboard.parentId) ? ` — parent: ${str(whiteboard.parentId)}` : '') +
          ` — id: ${str(whiteboard.id)}`
      );
    }
  );

  server.registerTool(
    'confluence_delete_whiteboard',
    {
      title: 'Confluence · Act — Delete a whiteboard',
      description: 'Delete a whiteboard object.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        whiteboardId: z.string().min(1).describe('Whiteboard id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const whiteboardId = str(args.whiteboardId);
      if (!whiteboardId) return errText('whiteboardId is required');
      const result = await confluenceDelete(
        context,
        access,
        `/api/v2/whiteboards/${encodeURIComponent(whiteboardId)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult('Whiteboard deleted.');
    }
  );
}
