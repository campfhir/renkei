/**
 * The admin's list of remote MCP servers (GET/POST /api/admin/mcp-servers,
 * DELETE …/[serverId]), on the memory store: what mcp-servers.spec.ts used
 * to check by filling the /admin/mcp form — a server on the legacy SSE
 * transport and an open one (no sign-in) are kept as added and listed back
 * with their transport, sign-in, tool prefix and context, never a secret.
 */

jest.mock('@/lib/access', () => ({
  ROLE_OPERATOR: 'renkei-operator',
  checkAccess: jest.fn(),
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, POST } from './route';
import { DELETE } from './[serverId]/route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const CONTEXT = 'Insurance policies and claims for the Acme carrier.';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue({ subject: 'operator-1', roles: ['renkei-operator'] });
});

afterEach(() => resetDataStore());

const request = (method: string, body?: unknown) =>
  new NextRequest('http://test.local/api/admin/mcp-servers', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function add(body: Record<string, unknown>) {
  const response = await POST(request('POST', body));
  return { status: response.status, body: await response.json() };
}

async function listed(): Promise<Record<string, unknown>[]> {
  const response = await GET(request('GET'));
  expect(response.status).toBe(200);
  return (await response.json()).servers;
}

describe('the admin list of MCP servers', () => {
  it('keeps a legacy SSE server and an open server as added, and lists them back', async () => {
    const sse = await add({
      name: 'Legacy SSE',
      url: 'https://mcp.acme.test/sse',
      transport: 'sse',
      slug: 'legacy',
      context: CONTEXT,
    });
    expect(sse.status).toBe(201);
    const open = await add({
      name: 'Open Docs',
      url: 'https://docs.acme.test/open/mcp',
      authMode: 'none',
      slug: 'open_docs',
      context: CONTEXT,
    });
    expect(open.status).toBe(201);

    const servers = await listed();
    expect(servers).toHaveLength(2);
    expect(servers.find((server) => server.slug === 'legacy')).toMatchObject({
      name: 'Legacy SSE',
      url: 'https://mcp.acme.test/sse',
      transport: 'sse',
      authMode: 'oauth',
      context: CONTEXT,
      enabled: true,
      hasClientSecret: false,
    });
    expect(servers.find((server) => server.slug === 'open_docs')).toMatchObject({
      name: 'Open Docs',
      transport: 'streamable_http',
      authMode: 'none',
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.server.created',
        details: { url: 'https://mcp.acme.test/sse', transport: 'sse', authMode: 'oauth' },
      })
    );
  });

  it('makes the tool prefix from the name when none is typed', async () => {
    const added = await add({ name: 'E2E Acme Docs', url: 'https://mcp.acme.test/mcp' });
    expect(added.status).toBe(201);
    expect(added.body.server.slug).toBe('e2e_acme_docs');
  });

  it('refuses a second server with a prefix already taken', async () => {
    await add({ name: 'Acme', url: 'https://mcp.acme.test/mcp', slug: 'acme' });
    const again = await add({ name: 'Acme two', url: 'https://two.acme.test/mcp', slug: 'acme' });
    expect(again).toEqual({
      status: 409,
      body: { error: 'Another server already uses the tool prefix "acme".' },
    });
    expect(await listed()).toHaveLength(1);
  });

  it('refuses a transport or sign-in it does not know', async () => {
    expect(
      (await add({ name: 'X', url: 'https://mcp.acme.test/mcp', transport: 'websocket' })).body
    ).toEqual({ error: 'The transport must be streamable_http or sse.' });
    expect(
      (await add({ name: 'X', url: 'https://mcp.acme.test/mcp', authMode: 'basic' })).body
    ).toEqual({ error: 'The sign-in mode must be oauth or none.' });
    expect(await listed()).toEqual([]);
  });

  it('a deleted server leaves the list', async () => {
    const added = await add({ name: 'Acme', url: 'https://mcp.acme.test/mcp' });
    const id: string = added.body.server.id;
    const response = await DELETE(request('DELETE'), { params: Promise.resolve({ serverId: id }) });
    expect(response.status).toBe(200);
    expect(await listed()).toEqual([]);
  });

  it('answers only an operator', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await GET(request('GET'))).status).toBe(401);
    expect((await add({ name: 'Acme', url: 'https://mcp.acme.test/mcp' })).status).toBe(401);
    mockCheckAccess.mockResolvedValue({ subject: 'operator-1', roles: ['renkei-operator'] });
    expect(await listed()).toEqual([]);
  });
});
