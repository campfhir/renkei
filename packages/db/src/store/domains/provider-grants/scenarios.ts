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
];
