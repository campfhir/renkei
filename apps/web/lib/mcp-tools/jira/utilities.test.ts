/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for the connect_jira tool.
 *
 * Two bugs are pinned here: the existing-grant check used to be tenant-wide,
 * reporting one user's Jira connection to another; and the connect link was a
 * hand-built auth.atlassian.com URL whose literal state ('jira-setup') could
 * never match a pending_oidc_signin row, so following it always failed at the
 * callback.
 */

jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// utilities.ts → common.ts → tenant-operations → db, which cannot load in a
// unit test environment; connect_jira only needs the injected context.db.
jest.mock('@/lib/tenant-operations', () => ({
  refreshAtlassianTokenDirect: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerUtilityTools } from './utilities';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function fakeServer(): { server: McpServer; handlers: Map<string, ToolHandler> } {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

function fakeDb(result: unknown): {
  db: MCPToolContext['db'];
  wheres: Array<[unknown, unknown, unknown]>;
} {
  const wheres: Array<[unknown, unknown, unknown]> = [];
  const chain = {
    selectFrom: () => chain,
    select: () => chain,
    where: (column: unknown, op: unknown, value: unknown) => {
      wheres.push([column, op, value]);
      return chain;
    },
    executeTakeFirst: async () => result,
  };
  return { db: chain as unknown as MCPToolContext['db'], wheres };
}

function contextWith(db: MCPToolContext['db']): MCPToolContext {
  return {
    tenantId: 'tenant-1',
    accountId: 'acct-caller',
    siteUrl: 'https://example.atlassian.net',
    apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    accessToken: 'token',
    maxJqlResults: 100,
    origin: 'https://mcp.example.com',
    db,
  };
}

async function connectJira(db: MCPToolContext['db']): Promise<{
  text: string;
  wheres: Array<[unknown, unknown, unknown]>;
}> {
  const { server, handlers } = fakeServer();
  await registerUtilityTools(server, contextWith(db));
  const handler = handlers.get('connect_jira');
  if (!handler) throw new Error('connect_jira was not registered');
  const result = await handler({});
  return { text: result.content[0]?.text ?? '', wheres: [] };
}

describe('connect_jira', () => {
  it('checks only the calling user’s grant, never the whole tenant', async () => {
    const { db, wheres } = fakeDb(undefined);
    await connectJira(db);

    expect(wheres).toContainEqual(['provider_account_id', '=', 'acct-caller']);
  });

  it('reports an existing grant belonging to the caller', async () => {
    const { db } = fakeDb({
      display_name: 'Caller Name',
      metadata: { siteUrl: 'https://example.atlassian.net' },
    });
    const { text } = await connectJira(db);

    expect(text).toContain('already connected as Caller Name');
  });

  it('links to this server’s authorize route, not a hand-built Atlassian URL', async () => {
    const { db } = fakeDb(undefined);
    const { text } = await connectJira(db);

    expect(text).toContain('https://mcp.example.com/api/mcp/tenant-1/authorize');
    expect(text).not.toContain('auth.atlassian.com');
    expect(text).not.toContain('jira-setup');
  });
});
