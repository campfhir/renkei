/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * FileShares, with no live store behind the tools. Mirrors
 * sharepoint.no-sandbox.test.ts: every registered tool, driven for real
 * through registerFileshareTools, turns a denied auth into a clean
 * errText() rather than crashing — the guarantee that matters when the
 * registry mounts these tools for a caller whose access evaporated
 * between registration and call.
 */

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerFileshareTools } from './index';
import { deniedFileshareAuth } from './fileshare-auth';
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

function tools(): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerFileshareTools(server, context(), deniedFileshareAuth());
  return registered;
}

const ARGS: Record<string, Record<string, unknown>> = {
  fileshare_list_shares: {},
  fileshare_list_folder: { shareId: '11111111-2222-3333-4444-555555555555', path: '/' },
  fileshare_stat: { shareId: '11111111-2222-3333-4444-555555555555', path: '/x' },
  fileshare_read_file: { shareId: '11111111-2222-3333-4444-555555555555', path: '/x' },
  fileshare_download_file: { shareId: '11111111-2222-3333-4444-555555555555', path: '/x' },
  fileshare_request_file_upload: {
    shareId: '11111111-2222-3333-4444-555555555555',
    path: '/',
    filename: 'x.txt',
  },
  fileshare_create_folder: { shareId: '11111111-2222-3333-4444-555555555555', path: '/x' },
};

test('every fileshare tool answers a denied auth with a clean error', async () => {
  const registered = tools();
  expect([...registered.keys()].sort()).toEqual(Object.keys(ARGS).sort());
  for (const [name, handler] of registered) {
    const result = await handler(ARGS[name] ?? {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBeTruthy();
  }
});
