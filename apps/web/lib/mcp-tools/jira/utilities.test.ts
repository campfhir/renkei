/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for the jira_connect tool.
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
import type { McpServer } from '@modelcontextprotocol/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
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

function grant(account: string, displayName: string) {
  return {
    provider: 'atlassian',
    provider_account_id: account,
    client_id: 'client',
    display_name: displayName,
    subject: `${account}@example.com`,
    encrypted_access_token: 'a',
    encrypted_refresh_token: 'r',
    expires_at: new Date(Date.now() + 60_000),
    metadata: { siteUrl: 'https://example.atlassian.net' },
  };
}

async function withGrants(rows: ReturnType<typeof grant>[]) {
  const store = createMemoryDataStore();
  await store.seed({ provider_grants: rows });
  registerDataStore(store);
}

function context(): MCPToolContext {
  return {
    accountId: 'acct-caller',
    siteUrl: 'https://example.atlassian.net',
    apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
    jiraAuth: null,
    maxJqlResults: 100,
    origin: 'https://mcp.example.com',
  };
}

async function connectJira(): Promise<string> {
  const { server, handlers } = fakeServer();
  await registerUtilityTools(server, context());
  const handler = handlers.get('jira_connect');
  if (!handler) throw new Error('jira_connect was not registered');
  const result = await handler({});
  return result.content[0]?.text ?? '';
}

afterEach(() => {
  resetDataStore();
});

describe('jira_connect', () => {
  it('checks only the calling user’s grant, never the whole tenant', async () => {
    await withGrants([grant('acct-other', 'Someone Else')]);
    const text = await connectJira();

    expect(text).not.toContain('Someone Else');
    expect(text).toContain('not connected');
  });

  it('reports an existing grant belonging to the caller', async () => {
    await withGrants([grant('acct-other', 'Someone Else'), grant('acct-caller', 'Caller Name')]);
    const text = await connectJira();

    expect(text).toContain('already connected as Caller Name');
  });

  it('links to this server’s authorize route, not a hand-built Atlassian URL', async () => {
    await withGrants([]);
    const text = await connectJira();

    expect(text).toContain('https://mcp.example.com/api/mcp/authorize');
    expect(text).not.toContain('auth.atlassian.com');
    expect(text).not.toContain('jira-setup');
  });
});
