/**
 * The Salesforce branch of the shared connect callback: the code is traded
 * with the PKCE verifier the authorize step stored, at the token endpoint of
 * the connector (org) the flow was started for; a token minted for any org
 * but that connector's is refused before anything is stored, and the grant
 * is keyed `<orgId>/<userId>` (a sandbox keeps production's user ids) with
 * the connector's key on its metadata. An earlier connection to the same
 * connector as someone else is revoked.
 * Nothing here reaches Salesforce or the delegate: both are stubbed.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/queue', () => ({ webhookEventsQueue: () => ({ producer: {} }) }));
jest.mock('@renkei/delegate-client', () => ({
  delegateGrants: jest.fn(),
  grantFetch: jest.fn(),
}));
jest.mock('@/lib/connect-flow-binding', () => ({
  isConnectFlowBound: () => true,
  clearConnectFlow: (response: unknown) => response,
}));
jest.mock('@/lib/get-origin', () => ({
  getOrigin: async () => ({ ok: true, val: 'https://renkei.example' }),
}));
jest.mock('@/lib/salesforce-app', () => ({ getSalesforceConnector: jest.fn() }));
jest.mock('@/lib/salesforce-grants', () => ({ listSalesforceConnections: jest.fn() }));
jest.mock('@/lib/mcp-tools/common', () => ({ cacheUserDisplayName: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const delegate = jest.requireMock<{ delegateGrants: jest.Mock; grantFetch: jest.Mock }>(
  '@renkei/delegate-client'
);
const { getSalesforceConnector: mockConnector } = jest.requireMock<{
  getSalesforceConnector: jest.Mock;
}>('@/lib/salesforce-app');
const { listSalesforceConnections: mockConnections } = jest.requireMock<{
  listSalesforceConnections: jest.Mock;
}>('@/lib/salesforce-grants');

const SUBJECT = 'ada@example.com';
const STATE = '0b6c7d8e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const ORG = '00D000000000062EAA';
const USER = '005000000000001AAA';

async function stubStore(codeVerifier: string | null, connectorKey: string | null = 'uat') {
  const store = createMemoryDataStore();
  await store.pendingSignins.create({
    id: '00000000-0000-4000-8000-0000000005f0',
    state: STATE,
    nonce: 'nonce',
    expiresAt: new Date(Date.now() + 60_000),
    subject: SUBJECT,
    provider: 'salesforce',
    scopes: 'sf-records-read sf-reports',
    codeVerifier,
    connectorKey,
  });
  registerDataStore(store);
}

function stubDelegate(instanceUrl: string) {
  const exchange = jest.fn().mockResolvedValue({
    ok: true,
    val: {
      handle: 'h-1',
      expiresAt: new Date().toISOString(),
      scope: 'api refresh_token id',
      idToken: null,
      grantedScopes: null,
      hasRefreshToken: true,
      instanceUrl,
      identityUrl: `https://login.salesforce.com/id/${ORG}/${USER}`,
    },
  });
  const commit = jest.fn().mockResolvedValue({ ok: true, val: { accountId: `${ORG}/${USER}` } });
  const revoke = jest.fn().mockResolvedValue({ ok: true, val: undefined });
  delegate.delegateGrants.mockReturnValue({ exchange, commit, revoke });
  delegate.grantFetch.mockReturnValue(
    async () =>
      new Response(JSON.stringify({ name: 'Ada Admin', preferred_username: 'ada@acme.org' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  return { exchange, commit, revoke };
}

function callback(): NextRequest {
  return new NextRequest(`https://renkei.example/api/oauth/callback?code=the-code&state=${STATE}`);
}

afterEach(() => resetDataStore());

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ id: 's', subject: SUBJECT, roles: [], expiresAt: new Date() });
  mockConnections.mockResolvedValue([]);
  mockConnector.mockImplementation(async (_origin: string, key: string) =>
    key === 'uat'
      ? {
          key: 'uat',
          name: 'UAT',
          myDomain: 'https://acme--uat.sandbox.my.salesforce.com',
          host: 'acme--uat.sandbox.my.salesforce.com',
          sandbox: true,
          enabled: true,
          clientId: 'sf-uat-client',
          clientSecret: 'sf-uat-secret',
          scopes: ['sf-records-read', 'sf-records-write', 'sf-reports'],
          ceiling: ['sf-records-read', 'sf-records-write', 'sf-reports'],
          redirectUri: 'https://renkei.example/api/oauth/callback',
        }
      : null
  );
});

describe('GET /api/oauth/callback — Salesforce', () => {
  it('exchanges with the PKCE verifier and stores the grant keyed by org and user', async () => {
    await stubStore('the-verifier');
    const { exchange, commit, revoke } = stubDelegate(
      'https://acme--uat.sandbox.my.salesforce.com'
    );

    const response = await GET(callback());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://renkei.example/connectors');
    expect(exchange).toHaveBeenCalledWith({
      provider: 'salesforce',
      org: 'uat',
      form: {
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: 'https://renkei.example/api/oauth/callback',
        code_verifier: 'the-verifier',
      },
    });
    expect(delegate.grantFetch).toHaveBeenCalledWith({ provider: 'salesforce', pending: 'h-1' });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'salesforce',
        handle: 'h-1',
        subject: SUBJECT,
        accountId: `${ORG}/${USER}`,
        displayName: 'Ada Admin',
        clientId: 'sf-uat-client',
        requestedScopes: ['sf-records-read', 'sf-reports'],
        metadata: {
          orgId: ORG,
          userId: USER,
          instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
          username: 'ada@acme.org',
          connector: 'uat',
        },
      })
    );
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes an earlier connection to the same connector as someone else', async () => {
    await stubStore('the-verifier');
    const { revoke } = stubDelegate('https://acme--uat.sandbox.my.salesforce.com');
    mockConnections.mockResolvedValue([
      { accountId: `${ORG}/005000000000002AAA`, connector: 'uat' },
      { accountId: `${ORG}/${USER}`, connector: 'uat' },
    ]);

    const response = await GET(callback());

    expect(response.status).toBe(307);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith({
      provider: 'salesforce',
      accountId: `${ORG}/005000000000002AAA`,
    });
  });

  it('refuses a flow for a connector that is no longer set up', async () => {
    await stubStore('the-verifier', 'gone');
    const { exchange } = stubDelegate('https://acme--uat.sandbox.my.salesforce.com');

    const response = await GET(callback());

    expect(response.status).toBe(503);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('refuses a token from another org and stores nothing', async () => {
    await stubStore('the-verifier');
    // Production's token on the UAT connector's flow: the wrong org.
    const { commit } = stubDelegate('https://acme.my.salesforce.com');

    const response = await GET(callback());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'That Salesforce login belongs to a different org',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses a pending flow with no PKCE verifier before any exchange', async () => {
    await stubStore(null);
    const { exchange } = stubDelegate('https://acme--uat.sandbox.my.salesforce.com');

    const response = await GET(callback());

    expect(response.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });
});
