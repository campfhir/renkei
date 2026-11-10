/**
 * A person's tools on one remote MCP server (GET/POST
 * /api/mcp-servers/[serverId]/tools), on the memory store. What
 * mcp-servers.spec.ts used to check through the Connectors page — a server
 * on the legacy SSE transport and an open server list their tools the same
 * way — is the route's: it asks the server over the transport the admin
 * chose, at its URL, as the person, and caches the answer per person.
 *
 * The MCP session is replaced at the client boundary (`withMcpSession`),
 * and the delegate's fetch with it; the transports themselves are
 * packages/connector-mcp/src/client.test.ts's (the legacy SSE stream and
 * its list_changed notice included).
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@renkei/delegate-client', () => ({
  grantFetch: jest.fn(() => jest.fn()),
  delegateRefusal: jest.fn(() => null),
}));
jest.mock('@renkei/connector-mcp', () => ({
  ...jest.requireActual('@renkei/connector-mcp'),
  withMcpSession: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  McpAuthRequired,
  createServer,
  updateServer,
  type McpListedTool,
} from '@renkei/connector-mcp';
import { GET, POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { grantFetch: mockGrantFetch } = jest.requireMock<{ grantFetch: jest.Mock }>(
  '@renkei/delegate-client'
);
const { withMcpSession: mockSession } = jest.requireMock<{ withMcpSession: jest.Mock }>(
  '@renkei/connector-mcp'
);

const ME = 'alice';
const LOOKUP: McpListedTool = {
  name: 'lookup_policy',
  description: 'Look up an insurance policy by number.',
  inputSchema: { type: 'object' },
  readOnly: true,
};
const FILE: McpListedTool = {
  name: 'file_claim',
  description: 'File a claim.',
  inputSchema: { type: 'object' },
  readOnly: false,
};

/** The server answers `tools/list` with these. */
function serverLists(tools: McpListedTool[]) {
  mockSession.mockImplementation(async (_options, use) => use({ listTools: async () => tools }));
}

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  serverLists([LOOKUP, FILE]);
});

afterEach(() => resetDataStore());

async function addServer(
  overrides: { transport?: 'sse' | 'streamable_http'; authMode?: 'oauth' | 'none' } = {}
): Promise<string> {
  const created = await createServer({
    slug: 'acme_docs',
    name: 'Acme Docs',
    url: overrides.transport === 'sse' ? 'https://mcp.acme.test/sse' : 'https://mcp.acme.test/mcp',
    transport: overrides.transport ?? 'streamable_http',
    authMode: overrides.authMode ?? 'oauth',
    context: 'Insurance policies.',
    scopes: null,
    clientId: null,
    encryptedClientSecret: null,
    enabled: true,
  });
  if (!created.ok) throw new Error('could not add the server');
  return created.val.id;
}

const params = (serverId: string) => ({ params: Promise.resolve({ serverId }) });
const request = (method: string) =>
  new NextRequest('http://test.local/api/mcp-servers/x/tools', {
    method,
    body: method === 'POST' ? '{}' : undefined,
  });

async function refresh(serverId: string) {
  const response = await POST(request('POST'), params(serverId));
  return { status: response.status, body: await response.json() };
}

async function cached(serverId: string) {
  const response = await GET(request('GET'), params(serverId));
  expect(response.status).toBe(200);
  return (await response.json()).tools;
}

const SHOWN = [
  { name: 'lookup_policy', description: 'Look up an insurance policy by number.', readOnly: true },
  { name: 'file_claim', description: 'File a claim.', readOnly: false },
];

describe('a person’s tools on a remote MCP server', () => {
  it('lists a legacy SSE server’s tools over SSE, at its URL, as the person, and keeps them', async () => {
    const id = await addServer({ transport: 'sse' });
    expect(await cached(id)).toEqual([]);

    const answer = await refresh(id);
    expect(answer.status).toBe(200);
    expect(answer.body.tools).toEqual(SHOWN);
    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.acme.test/sse', transport: 'sse' }),
      expect.any(Function)
    );
    expect(mockGrantFetch).toHaveBeenCalledWith(
      { provider: `mcp:${id}`, subject: ME },
      expect.anything()
    );
    expect(await cached(id)).toEqual(SHOWN);
  });

  it('lists an open server’s tools the same way, with nobody having connected', async () => {
    const id = await addServer({ authMode: 'none' });
    const answer = await refresh(id);
    expect(answer.status).toBe(200);
    expect(answer.body.tools).toEqual(SHOWN);
    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.acme.test/mcp', transport: 'streamable_http' }),
      expect.any(Function)
    );
    expect(await cached(id)).toEqual(SHOWN);
  });

  it('keeps each person’s list to themselves', async () => {
    const id = await addServer();
    await refresh(id);
    mockGetSession.mockResolvedValue({ subject: 'bob', roles: ['renkei-user'] });
    expect(await cached(id)).toEqual([]);
  });

  it('a refresh follows the server when its list changes', async () => {
    const id = await addServer({ transport: 'sse' });
    await refresh(id);
    serverLists([LOOKUP, FILE, { ...LOOKUP, name: 'renew_policy', description: 'Renew.' }]);
    const answer = await refresh(id);
    expect(answer.body.tools).toHaveLength(3);
    expect(await cached(id)).toHaveLength(3);
  });

  it('asks the person to connect again when the server wants a sign-in, keeping the list it had', async () => {
    const id = await addServer();
    await refresh(id);
    mockSession.mockRejectedValue(new McpAuthRequired(null));
    expect(await refresh(id)).toEqual({
      status: 401,
      body: { error: 'Connect this server again.', reason: 'auth_required' },
    });
    expect(await cached(id)).toEqual(SHOWN);
  });

  it('says what went wrong when the server fails', async () => {
    const id = await addServer();
    mockSession.mockRejectedValue(new Error('The MCP server answered 500.'));
    expect(await refresh(id)).toEqual({
      status: 502,
      body: { error: 'The MCP server answered 500.', reason: 'failed' },
    });
  });

  it('knows no server that is switched off or was never added', async () => {
    const id = await addServer();
    await updateServer(id, { enabled: false });
    expect((await refresh(id)).status).toBe(404);
    expect((await refresh('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(mockSession).not.toHaveBeenCalled();
  });

  it('answers nobody who is not signed in', async () => {
    const id = await addServer();
    mockGetSession.mockResolvedValue(null);
    expect((await GET(request('GET'), params(id))).status).toBe(401);
    expect((await refresh(id)).status).toBe(401);
  });
});
