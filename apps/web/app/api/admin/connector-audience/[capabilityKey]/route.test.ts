/**
 * A connector's audience route, on the memory store: what the audience
 * control's saves store (the group values trimmed, each once; an emptied
 * list back to everyone), what it refuses, and that a change reaches the
 * tool catalog at once. The control's own rules are
 * app/(app)/admin/connectors/[configKey]/audience-control.model.test.ts.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, PUT } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { invalidateToolCatalogCache } = jest.requireMock<{ invalidateToolCatalogCache: jest.Mock }>(
  '@/lib/mcp-tools/tool-catalog'
);

const params = (capabilityKey: string) => ({ params: Promise.resolve({ capabilityKey }) });
const put = (capabilityKey: string, body: unknown) =>
  PUT(
    new NextRequest(`http://test.local/api/admin/connector-audience/${capabilityKey}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    params(capabilityKey)
  );
const stored = async (capabilityKey: string) =>
  (
    await GET(
      new NextRequest(`http://test.local/api/admin/connector-audience/${capabilityKey}`),
      params(capabilityKey)
    )
  ).json();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RENKEI_CONFIG_CACHE_TTL_MS = '0';
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue({ subject: 'operator', roles: ['renkei-operator'] });
});

afterEach(() => resetDataStore());

describe('PUT /api/admin/connector-audience/:capabilityKey', () => {
  it('stores the groups trimmed and each once, and refreshes the tool catalog', async () => {
    const response = await put('jira', { claimValues: [' eng ', 'ops', 'eng', '', 7] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claimValues: ['eng', 'ops'] });
    expect(await stored('jira')).toEqual({ claimValues: ['eng', 'ops'] });
    expect(invalidateToolCatalogCache).toHaveBeenCalled();
  });

  it('an emptied list is everyone again', async () => {
    await put('jira', { claimValues: ['eng'] });
    await put('jira', { claimValues: [] });
    expect(await stored('jira')).toEqual({ claimValues: [] });
  });

  it('one connector’s audience leaves another’s alone', async () => {
    await put('jira', { claimValues: ['eng'] });
    await put('jira-admin', { claimValues: ['admins'] });
    expect(await stored('jira')).toEqual({ claimValues: ['eng'] });
  });

  it('refuses more than 50 groups, a missing list and an unknown connector', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `g${i}`);
    expect((await put('jira', { claimValues: many })).status).toBe(400);
    expect((await put('jira', {})).status).toBe(400);
    expect((await put('not-a-connector', { claimValues: [] })).status).toBe(404);
  });

  it('is an operator’s', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await put('jira', { claimValues: [] })).status).toBe(401);
  });
});
