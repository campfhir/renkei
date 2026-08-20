/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * OneDrive, with no sandbox to test against. Mirrors
 * sharepoint/sharepoint.no-sandbox.test.ts — see that file, and
 * webex/zoom's equivalents, for the full reasoning.
 */

// index.ts's own import of withPresentationHint from ../common transitively
// reaches @renkei/db (via tenant-operations.ts) for exports this file never
// touches, and @renkei/db imports kysely — ESM-only, unparseable here. Exists
// purely to keep the module graph parseable; deniedGraphAuth() denies before
// any handler would reach a real database call regardless.
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerOneDriveTools } from './index';
import { deniedGraphAuth } from '../graph/graph-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
  }) as unknown as MCPToolContext;

async function tools(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerOneDriveTools(server, context(), deniedGraphAuth());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

const TOOLS = [
  // index.ts
  'onedrive_list_recent',
  'onedrive_list_shared_with_me',
  // graph/documents.ts, prefix='onedrive'
  'onedrive_list_folder',
  'onedrive_get_document',
  'onedrive_read_document',
  'onedrive_download_document',
  'onedrive_search_documents',
  'onedrive_create_folder',
  'onedrive_rename_document',
  'onedrive_move_document',
  'onedrive_copy_document',
  'onedrive_delete_document',
  'onedrive_request_document_upload',
  'onedrive_list_document_access',
  'onedrive_share_document',
  'onedrive_add_user_to_document',
  'onedrive_remove_user_from_document',
];

describe('every OneDrive tool, against a denied credential', () => {
  it('covers every tool registerOneDriveTools actually registers', async () => {
    const registered = [...(await tools()).keys()].sort();
    expect([...TOOLS].sort()).toEqual(registered);
  });

  it.each(TOOLS)('%s fails cleanly, not by throwing', async (tool) => {
    const handler = (await tools()).get(tool)!;

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
    expect(textOf(result)).not.toContain('undefined');
    expect(textOf(result)).not.toContain('[object Object]');
  });

  it('names the actual reason, not a bare status code', async () => {
    const result = await (await tools()).get('onedrive_list_recent')!({});

    expect(textOf(result)).toContain('No Microsoft test credential is configured');
  });
});
