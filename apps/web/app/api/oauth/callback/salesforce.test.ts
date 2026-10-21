/**
 * The Salesforce branch of the shared connect callback: the code is traded
 * with the PKCE verifier the authorize step stored, a token minted for any
 * org but the configured one is refused before anything is stored, and the
 * grant is keyed `<orgId>/<userId>` (a sandbox keeps production's user ids).
 * Nothing here reaches Salesforce or the delegate: both are stubbed.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
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
jest.mock('@/lib/salesforce-app', () => ({ getSalesforceApp: jest.fn() }));
jest.mock('@/lib/mcp-tools/common', () => ({ cacheUserDisplayName: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const delegate = jest.requireMock<{ delegateGrants: jest.Mock; grantFetch: jest.Mock }>(
  '@renkei/delegate-client'
);
const { getSalesforceApp: mockApp } = jest.requireMock<{ getSalesforceApp: jest.Mock }>(
  '@/lib/salesforce-app'
);

const SUBJECT = 'ada@example.com';
const STATE = '0b6c7d8e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const ORG = '00D000000000062EAA';
const USER = '005000000000001AAA';

function stubDb(codeVerifier: string | null) {
  const db = {
    selectFrom: () => {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => ({
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          subject: SUBJECT,
          provider: 'salesforce',
          scopes: 'sf-records-read sf-reports',
          code_verifier: codeVerifier,
        }),
      };
      return chain;
    },
    deleteFrom: () => ({ where: () => ({ async execute() {} }) }),
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
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
  delegate.delegateGrants.mockReturnValue({ exchange, commit });
  delegate.grantFetch.mockReturnValue(
    async () =>
      new Response(JSON.stringify({ name: 'Ada Admin', preferred_username: 'ada@acme.org' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  return { exchange, commit };
}

function callback(): NextRequest {
  return new NextRequest(`https://renkei.example/api/oauth/callback?code=the-code&state=${STATE}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ id: 's', subject: SUBJECT, roles: [], expiresAt: new Date() });
  mockApp.mockResolvedValue({
    clientId: 'sf-client',
    clientSecret: 'sf-secret',
    myDomain: 'https://acme.my.salesforce.com',
    scopes: 'sf-records-read sf-records-write sf-reports',
    redirectUri: 'https://renkei.example/api/oauth/callback',
  });
});

describe('GET /api/oauth/callback — Salesforce', () => {
  it('exchanges with the PKCE verifier and stores the grant keyed by org and user', async () => {
    stubDb('the-verifier');
    const { exchange, commit } = stubDelegate('https://acme.my.salesforce.com');

    const response = await GET(callback());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://renkei.example/connectors');
    expect(exchange).toHaveBeenCalledWith({
      provider: 'salesforce',
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
        requestedScopes: ['sf-records-read', 'sf-reports'],
        metadata: {
          orgId: ORG,
          userId: USER,
          instanceUrl: 'https://acme.my.salesforce.com',
          username: 'ada@acme.org',
        },
      })
    );
  });

  it('refuses a token from another org and stores nothing', async () => {
    stubDb('the-verifier');
    const { commit } = stubDelegate('https://someone-else.my.salesforce.com');

    const response = await GET(callback());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'That Salesforce login belongs to a different org',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses a pending flow with no PKCE verifier before any exchange', async () => {
    stubDb(null);
    const { exchange } = stubDelegate('https://acme.my.salesforce.com');

    const response = await GET(callback());

    expect(response.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });
});
