/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The Atlassian API token route: the secret goes to the delegate once and
 * is checked only through it; a token Atlassian refuses is dropped again;
 * a 403 keeps it with a note; it is tied to the Jira Administration
 * grant's site; and removing it is the delegate's delete.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@renkei/delegate-client', () => ({ delegateGrants: () => grants }));
jest.mock('@/lib/mcp-tools/jira-admin/client', () => ({ jiraAdminGet: jest.fn() }));
jest.mock('@/lib/mcp-tools/jira-admin/automation-client', () => ({
  resolveAutomationAccess: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { POST, DELETE } from './route';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { jiraAdminGet } from '@/lib/mcp-tools/jira-admin/client';
import { resolveAutomationAccess } from '@/lib/mcp-tools/jira-admin/automation-client';

const grants = {
  describe: jest.fn(),
  store: jest.fn(),
  delete: jest.fn(),
};

/** A stored token grant, as the delegate would have written it. */
function tokenGrant(subject: string, accountId: string) {
  return {
    provider: 'atlassian-admin-token',
    provider_account_id: accountId,
    subject,
    client_id: 'api-token',
    display_name: subject,
    encrypted_access_token: 'sealed',
    encrypted_refresh_token: 'sealed',
    expires_at: new Date('2030-01-01T00:00:00.000Z'),
  };
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/atlassian-admin/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

afterEach(() => resetDataStore());

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  jest.mocked(getSessionFromRequest).mockResolvedValue({
    id: 'session-1',
    subject: 'owner',
    roles: [],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  grants.describe.mockResolvedValue({
    ok: true,
    val: {
      accountId: 'acct-1',
      metadata: { cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' },
    },
  });
  grants.store.mockResolvedValue({ ok: true });
  grants.delete.mockResolvedValue({ ok: true });
  jest.mocked(resolveAutomationAccess).mockResolvedValue({
    cloudId: 'cloud-1',
    siteUrl: '',
    accountId: 'acct-1',
    email: 'dana@example.com',
    auth: jest.fn() as never,
  });
  jest.mocked(jiraAdminGet).mockResolvedValue({ ok: true, body: { data: [] } });
});

it('stores the token beside the admin grant and checks it through the delegate', async () => {
  const response = await post({ email: 'dana@example.com', token: 'ATATT3x-secret' });
  expect(response.status).toBe(200);
  expect(grants.store).toHaveBeenCalledWith({
    provider: 'atlassian-admin-token',
    subject: 'owner',
    accountId: 'acct-1',
    displayName: 'dana@example.com',
    secret: 'ATATT3x-secret',
    metadata: {
      email: 'dana@example.com',
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
    },
  });
  expect(jest.mocked(jiraAdminGet).mock.calls[0]?.[2]).toBe('/rest/v1/rule/summary?limit=1');
  expect(grants.delete).not.toHaveBeenCalled();
  expect(recordAuditEvent).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'connector.connected', targetLabel: 'atlassian-admin-token' })
  );
  expect(await response.json()).toEqual({ message: 'API token saved', note: null });
});

it('drops a token Atlassian refuses', async () => {
  jest.mocked(jiraAdminGet).mockResolvedValue({ ok: false, error: 'refused', status: 401 });
  const response = await post({ email: 'dana@example.com', token: 'wrong' });
  expect(response.status).toBe(400);
  expect(grants.delete).toHaveBeenCalledWith({
    provider: 'atlassian-admin-token',
    accountId: 'acct-1',
  });
  expect((await response.json()).error).toContain(
    'Atlassian refused that token, so it was not kept'
  );
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

it('keeps a token the account may not use yet, with a note', async () => {
  jest.mocked(jiraAdminGet).mockResolvedValue({ ok: false, error: 'forbidden', status: 403 });
  const response = await post({ email: 'dana@example.com', token: 'ATATT3x-secret' });
  expect(response.status).toBe(200);
  expect(grants.delete).not.toHaveBeenCalled();
  expect((await response.json()).note).toContain('may not manage automation rules');
});

it('needs the Jira Administration grant first, an email and a token', async () => {
  grants.describe.mockResolvedValue({ ok: false, err: { type: 'NO_GRANT' } });
  expect((await post({ email: 'dana@example.com', token: 'x' })).status).toBe(409);
  grants.describe.mockResolvedValue({ ok: true, val: { accountId: 'acct-1', metadata: {} } });
  expect((await post({ email: 'not-an-email', token: 'x' })).status).toBe(400);
  expect((await post({ email: 'dana@example.com', token: '' })).status).toBe(400);
  expect(grants.store).not.toHaveBeenCalled();
});

it('removes the token through the delegate, and only the caller’s', async () => {
  const store = createMemoryDataStore();
  await store.seed({
    provider_grants: [tokenGrant('someone-else', 'acct-0'), tokenGrant('owner', 'acct-1')],
  });
  registerDataStore(store);
  const response = await DELETE(
    new NextRequest('http://localhost/api/atlassian-admin/token', { method: 'DELETE' })
  );
  expect(response.status).toBe(200);
  expect(grants.delete).toHaveBeenCalledWith({
    provider: 'atlassian-admin-token',
    accountId: 'acct-1',
  });
  expect(recordAuditEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'connector.disconnected',
      targetLabel: 'atlassian-admin-token',
    })
  );
  jest.mocked(getSessionFromRequest).mockResolvedValue(null);
  const refused = await DELETE(
    new NextRequest('http://localhost/api/atlassian-admin/token', { method: 'DELETE' })
  );
  expect(refused.status).toBe(401);
});
