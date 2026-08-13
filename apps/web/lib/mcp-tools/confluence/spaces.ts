/* eslint-disable @typescript-eslint/no-explicit-any */
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

function spaceLine(space: Record<string, unknown>): string {
  return (
    `${str(space.name) || '(unnamed)'} — ${str(space.key)} — ${str(space.type)}` +
    (str(space.status) !== 'current' ? ` — ${str(space.status)}` : '') +
    ` — id: ${str(space.id)}`
  );
}

export async function registerSpaceTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'confluence_list_spaces',
    {
      title: 'Confluence · Read — List spaces',
      description:
        'List Confluence spaces, newest-created first. Space ids feed every other tool that ' +
        'takes a spaceId. For finding a space by name, prefer confluence_search — this endpoint ' +
        "doesn't support free-text search, only listing/filtering by type and status.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        type: z.enum(['global', 'personal']).describe('Only spaces of this type').optional(),
        status: z.enum(['current', 'archived']).describe('Default: current').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [`limit=${max}`, `status=${str(args.status) || 'current'}`];
      if (str(args.type)) parts.push(`type=${str(args.type)}`);
      const result = await confluenceGet(context, access, `/api/v2/spaces?${parts.join('&')}`);
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(spaceLine);
      if (lines.length === 0) return textResult('No spaces.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Name, Key, Type, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'confluence_get_space',
    {
      title: 'Confluence · Read — Get one space',
      description: 'Fetch a single space by id, with its description and permissions summary.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        spaceId: z.string().min(1).describe('Space id from confluence_list_spaces'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveConfluenceAccess(context);
      if (typeof access === 'string') return errText(access);
      const spaceId = str(args.spaceId);
      if (!spaceId) return errText('spaceId is required');

      const [space, permissions] = await Promise.all([
        confluenceGet(
          context,
          access,
          `/api/v2/spaces/${encodeURIComponent(spaceId)}?description-format=plain`
        ),
        confluenceGet(
          context,
          access,
          `/api/v2/spaces/${encodeURIComponent(spaceId)}/permissions?limit=50`
        ),
      ]);
      if (!space.ok) return errText(space.error);

      const description = str(rec(rec(space.body.description).plain).value);
      const permissionLines = permissions.ok
        ? values(permissions.body).map((permission) => {
            const principal = rec(permission.principal);
            const operation = rec(permission.operation);
            return `${str(operation.key) || '(operation)'} — ${str(principal.type)}:${str(principal.id)}`;
          })
        : [];

      return textResult(
        [
          spaceLine(space.body),
          description ? `\nDescription:\n${description}` : '',
          `\nHomepage id: ${str(space.body.homepageId) || '(none)'}`,
          permissionLines.length > 0
            ? `\nPermissions (${permissionLines.length}):\n${permissionLines.map((line) => `  • ${line}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
  );
}
