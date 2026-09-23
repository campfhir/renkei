/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthJiraAdminAuth` in isolation — the confluence-auth.test.ts shape:
 * resolve() walks the caller's own grant on the fifth Atlassian app, and
 * every way it can come up empty is a sentence, never a throw.
 */

let grantRow: { provider_account_id: string } | undefined;
let grant: Record<string, unknown> | null;
let app: { clientSecret: string } | null;
let refreshResult: unknown;
const queriedProviders: unknown[] = [];

jest.mock('@renkei/provider-grants', () => ({
  getGrant: jest.fn(async () => ({ ok: true, val: grant })),
  refreshGrantTokens: jest.fn(async () => refreshResult),
  ATLASSIAN_ADMIN: 'atlassian-admin',
  AtlassianAdapter: class {
    constructor(
      readonly secret: string,
      readonly provider: string
    ) {}
  },
  readAtlassianMetadata: (metadata: Record<string, unknown>) => ({
    cloudId: typeof metadata?.cloudId === 'string' ? metadata.cloudId : '',
    siteUrl: typeof metadata?.siteUrl === 'string' ? metadata.siteUrl : '',
  }),
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn(async () => app) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/db', () => {
  const chain: unknown = new Proxy(
    {},
    {
      get: (_t, property) => {
        if (property === 'executeTakeFirst') return async () => grantRow;
        if (property === 'where') {
          return (column: string, _op: string, value: unknown) => {
            if (column === 'provider') queriedProviders.push(value);
            return chain;
          };
        }
        return () => chain;
      },
    }
  );
  return { getDatabase: () => ({ ok: true, val: chain }) };
});

import { refreshGrantTokens } from '@renkei/provider-grants';
import { oauthJiraAdminAuth } from './jira-admin-auth';
import type { MCPToolContext } from '../common';

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({ tenantId: 'tenant-1', subject: 'subject-1', ...overrides }) as unknown as MCPToolContext;

const freshGrant = (overrides: Record<string, unknown> = {}) => ({
  accessToken: 'token-1',
  accountId: 'acct-1',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  metadata: { cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' },
  ...overrides,
});

beforeEach(() => {
  grantRow = { provider_account_id: 'acct-1' };
  grant = freshGrant();
  app = { clientSecret: 'secret' };
  refreshResult = { ok: true, val: { accessToken: 'token-2' } };
  queriedProviders.length = 0;
  jest.mocked(refreshGrantTokens).mockClear();
});

describe('oauthJiraAdminAuth', () => {
  it('resolves the caller’s own admin grant, with its site', async () => {
    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toEqual({
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      accountId: 'acct-1',
      authHeader: 'Bearer token-1',
    });
    // The admin grant, never the everyday Jira one.
    expect(queriedProviders).toEqual(['atlassian-admin']);
  });

  it('says how to connect when the caller has no admin grant', async () => {
    grantRow = undefined;

    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toContain('Jira Administration is not connected');
  });

  it('refreshes a token inside the expiry margin, on the admin app', async () => {
    grant = freshGrant({ expiresAt: new Date(Date.now() + 30_000).toISOString() });

    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toMatchObject({ authHeader: 'Bearer token-2' });
    const adapter = jest.mocked(refreshGrantTokens).mock.calls[0]?.[0] as unknown as {
      provider: string;
    };
    expect(adapter.provider).toBe('atlassian-admin');
  });

  it('asks for a reconnect when the refresh finds the grant revoked', async () => {
    grant = freshGrant({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    refreshResult = { ok: false, err: { type: 'GRANT_REVOKED' } };

    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toContain('revoked');
  });

  it('refuses a grant with no site id rather than calling a blank cloud', async () => {
    grant = freshGrant({ metadata: {} });

    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toContain('missing its site id');
  });

  it('reports a session with no subject as a sentence, not a throw', async () => {
    const access = await oauthJiraAdminAuth(context({ subject: undefined })).resolve();

    expect(access).toContain('No signed-in subject');
  });
});
