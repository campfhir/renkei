import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

function grant(
  provider: string,
  account: string,
  subject: string | null,
  extra: Record<string, unknown> = {}
) {
  return {
    provider,
    provider_account_id: account,
    client_id: 'client',
    display_name: `${provider} ${account}`,
    subject,
    encrypted_access_token: 'sealed-a',
    encrypted_refresh_token: 'sealed-r',
    expires_at: '2026-01-01T01:00:00.000Z',
    ...extra,
  };
}

const fixture = {
  provider_grants: [
    grant('zoom', 'z1', 'ann', {
      requested_scopes: ['a', 'b'],
      granted_scopes: ['a'],
      metadata: JSON.stringify({ allSpaces: true }),
    }),
    grant('atlassian', 'b2', 'ann'),
    grant('atlassian', 'a1', 'ann', { granted_scopes: null }),
    grant('mcp:00000000-0000-4000-8000-000000000001', 'm1', 'ann'),
    grant('mcpx', 'm2', 'ann'),
    grant('mcp:00000000-0000-4000-8000-000000000002', 'm3', 'bob'),
    grant('microsoft', 'ms1', 'ann', {
      metadata: JSON.stringify({ tenant: 't', indexing: { mail: false } }),
    }),
    grant('microsoft', 'ms2', null),
  ],
};

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const latestFixture = {
  provider_grants: [
    grant('atlassian', 'a-old', 'ann', { updated_at: at(1) }),
    grant('atlassian', 'b-tie', 'bob', {
      updated_at: at(5),
      metadata: JSON.stringify({ cloudId: 'c1' }),
    }),
    grant('atlassian', 'a-tie', 'carol', { updated_at: at(5) }),
    grant('atlassian-jsm', 'j1', 'ann', { updated_at: at(3) }),
    grant('atlassian-jsm', 'j2', 'bob', { updated_at: at(9) }),
    grant('atlassian-admin', 'x1', null, { updated_at: at(2) }),
  ],
};

const disconnectFixture = {
  provider_grants: [
    grant('atlassian', 'a1', 'ann'),
    grant('atlassian', 'a2', 'ann'),
    grant('zoom', 'z1', 'ann'),
    grant('atlassian', 'b1', 'bob'),
  ],
  oauth_clients: [
    { client_id: 'client-1', client_secret_hash: 'h', redirect_uris: ['https://x.test'] },
  ],
  oauth_access_tokens: [
    { token_hash: 'a1', client_id: 'client-1', subject: 'ann', expires_at: '2030-01-01T00:00:00Z' },
    { token_hash: 'a2', client_id: 'client-1', subject: 'ann', expires_at: '2030-01-01T00:00:00Z' },
    { token_hash: 'a3', client_id: 'client-1', subject: 'bob', expires_at: '2030-01-01T00:00:00Z' },
  ],
  oauth_refresh_tokens: [
    {
      token_hash: 'r1',
      token_id: '00000000-0000-4000-8000-5f0000000001',
      client_id: 'client-1',
      subject: 'ann',
      expires_at: '2030-01-01T00:00:00Z',
    },
  ],
};

export const providerGrantScenarios: Scenario<DataStore>[] = [
  {
    method: 'providerGrants.listForSubject',
    name: 'own grants by provider then account, filtered by provider or prefix',
    fixture,
    run: async (store) => [
      await store.providerGrants.listForSubject('ann'),
      await store.providerGrants.listForSubject('ann', { provider: 'microsoft' }),
      (await store.providerGrants.listForSubject('ann', { providerPrefix: 'mcp:' })).map(
        (g) => g.provider
      ),
      (await store.providerGrants.listForSubject('ann', { providerPrefix: 'MCP:' })).length,
      await store.providerGrants.listForSubject('nobody'),
    ],
  },
  {
    method: 'providerGrants.deleteForProvider',
    name: 'everyone’s grants on that provider, exactly',
    fixture,
    run: async (store) => [
      await store.providerGrants.deleteForProvider('microsoft'),
      await store.providerGrants.deleteForProvider('mcp:'),
      (await store.providerGrants.listForSubject('ann')).map((g) => g.provider),
    ],
  },
  {
    method: 'providerGrants.mergeMetadata',
    name: 'merges keys over the stored object, one row only',
    fixture,
    run: async (store) => [
      await store.providerGrants.mergeMetadata('microsoft', 'ms1', {
        indexing: { mail: true },
        extra: [1],
      }),
      await store.providerGrants.mergeMetadata('microsoft', 'missing', { a: 1 }),
      await store.providerGrants.listForSubject('ann', { provider: 'microsoft' }),
      await store.providerGrants.listForSubject('ann', { provider: 'zoom' }),
    ],
  },
  {
    method: 'providerGrants.find',
    name: 'by provider and account, whoever holds it',
    fixture,
    run: async (store) => [
      await store.providerGrants.find('microsoft', 'ms1'),
      await store.providerGrants.find('microsoft', 'ms2'),
      await store.providerGrants.find('zoom', 'ms1'),
      await store.providerGrants.find('nothing', 'none'),
    ],
  },
  {
    method: 'providerGrants.latestOf',
    name: 'newest update first, ties by provider then account, optionally one person',
    fixture: latestFixture,
    run: async (store) => [
      (await store.providerGrants.latestOf(['atlassian', 'atlassian-jsm']))?.accountId,
      (await store.providerGrants.latestOf(['atlassian']))?.accountId,
      (await store.providerGrants.latestOf(['atlassian', 'atlassian-jsm'], { subject: 'ann' }))
        ?.accountId,
      await store.providerGrants.latestOf(['atlassian-jsm'], { subject: 'ann' }),
      await store.providerGrants.latestOf(['atlassian-confluence', 'atlassian-admin']),
      await store.providerGrants.latestOf(['nothing']),
      await store.providerGrants.latestOf([]),
    ],
  },
  {
    method: 'providerGrants.disconnectWithMcpTokens',
    name: 'one person on one provider, with all their MCP tokens',
    fixture: disconnectFixture,
    run: async (store) => [
      await store.providerGrants.disconnectWithMcpTokens('atlassian', 'ann'),
      await store.providerGrants.disconnectWithMcpTokens('atlassian', 'ann'),
      (await store.providerGrants.listForSubject('ann')).map((g) => g.provider),
      (await store.providerGrants.listForSubject('bob')).map((g) => g.provider),
      await store.providerGrants.disconnectWithMcpTokens('atlassian', 'bob'),
    ],
  },
];
