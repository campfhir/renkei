/**
 * The OneDrive MCP namespace.
 *
 * Nearly all of it is the shared drive tool set from graph/documents.ts,
 * because a OneDrive IS a drive — once /me/drive is resolved to an id, the
 * calls are identical to SharePoint's. What is genuinely OneDrive-shaped is
 * the pair of listings below: "what did I touch recently" and "what have
 * people shared with me" have no SharePoint equivalent.
 *
 * Separate from SharePoint as a capability connector so an org can enable
 * personal files without opening the whole document estate, or the reverse.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { withPresentationHint } from '../common';
import { withScopeGate } from '../capability-gate';
import { registerDocumentTools } from '../graph/documents';
import type { GraphAuth } from '../graph/graph-auth';
import { graphGet, values, str, num, rec, textResult, errText, byteSize } from '../graph/client';
import { onedriveScopeFor } from './scopes';

export const ONEDRIVE_MCP_CONNECTOR = 'onedrive';

function fileLine(entry: Record<string, unknown>): string {
  const size = byteSize(num(entry.size));
  const modified = str(entry.lastModifiedDateTime).slice(0, 10);
  const parent = str(rec(entry.parentReference).path).replace(/^\/drive\/root:?/, '') || '/';
  return (
    `📄 ${str(entry.name)}${size ? ` — ${size}` : ''}${modified ? `, modified ${modified}` : ''}\n` +
    `    in ${parent}\n    itemId: ${str(entry.id)}`
  );
}

export async function registerOneDriveTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.graphScopes, (name) => onedriveScopeFor(name));

  server.registerTool(
    'onedrive_list_recent',
    {
      title: 'OneDrive · Read — List recently used files',
      description:
        'Files the user opened or edited recently, newest first — the fastest way to reach ' +
        '"the document I was just working on" without knowing where it lives.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        max: z.number().int().min(1).max(100).describe('How many (default 25).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const max = num(args.max) ?? 25;
      const recent = await graphGet(context, access.accessToken, `/me/drive/recent?$top=${max}`);
      if (!recent.ok) return errText(recent.error);

      const entries = values(recent.body);
      if (entries.length === 0) return textResult('No recent files.');
      return textResult(
        withPresentationHint(
          `${entries.length} recent file(s)\n\n${entries.map(fileLine).join('\n')}`,
          'Render as a list, most recent first.'
        )
      );
    }
  );

  server.registerTool(
    'onedrive_list_shared_with_me',
    {
      title: 'OneDrive · Read — List files other people shared with me',
      description:
        'Files and folders others have shared with the user. These live in THEIR drives, so ' +
        'each entry carries the driveId and itemId the other tools need to reach it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        max: z.number().int().min(1).max(100).describe('How many (default 25).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const shared = await graphGet(context, access.accessToken, '/me/drive/sharedWithMe');
      if (!shared.ok) return errText(shared.error);

      const max = num(args.max) ?? 25;
      const entries = values(shared.body).slice(0, max);
      if (entries.length === 0) return textResult('Nothing has been shared with you.');

      const lines = entries.map((entry) => {
        const parent = rec(entry.remoteItem ?? entry).parentReference;
        const owner = str(rec(rec(entry.createdBy).user).displayName);
        return (
          `📄 ${str(entry.name)}${owner ? ` — shared by ${owner}` : ''}\n` +
          `    driveId: ${str(rec(parent).driveId)}\n    itemId: ${str(entry.id)}`
        );
      });
      return textResult(
        withPresentationHint(
          `${entries.length} shared item(s)\n\n${lines.join('\n')}`,
          'Render as a list of shared files.'
        )
      );
    }
  );

  registerDocumentTools(server, context, auth, {
    prefix: 'onedrive',
    title: 'OneDrive',
    // Unlike SharePoint, "the drive" is unambiguous here, so every selector
    // is optional and the tools default to the caller's own OneDrive.
    usesMyDrive: true,
  });
}
