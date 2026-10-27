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
  {
    method: 'providerGrants.getByAccount',
    name: 'by provider and account, whoever holds it',
    fixture,
    run: async (store) => [
      await store.providerGrants.getByAccount('atlassian', 'a1'),
      await store.providerGrants.getByAccount('microsoft', 'ms2'),
      await store.providerGrants.getByAccount('zoom', 'a1'),
    ],
  },
  {
    method: 'providerGrants.disconnectWithTokens',
    name: 'the subject’s grants on one provider and all their MCP tokens',
    fixture: {
      ...fixture,
      oauth_clients: [
        {
          client_id: 'cli',
          client_name: null,
          client_secret_hash: 'h',
          redirect_uris: [],
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      oauth_access_tokens: ['ann', 'bob'].map((subject) => ({
        token_hash: `a-${subject}`,
        client_id: 'cli',
        subject,
        expires_at: '2026-01-02T00:00:00.000Z',
      })),
      oauth_refresh_tokens: ['ann', 'bob'].map((subject, n) => ({
        token_id: `00000000-0000-4000-8000-00000000000${n}`,
        client_id: 'cli',
        subject,
        token_hash: `r-${subject}`,
        expires_at: '2026-01-02T00:00:00.000Z',
      })),
    },
    run: async (store) => [
      await store.providerGrants.disconnectWithTokens('atlassian', 'ann'),
      await store.providerGrants.disconnectWithTokens('atlassian', 'ann'),
      (await store.providerGrants.listForSubject('ann')).map((g) => g.provider),
      await store.oauthTokens.findAccessToken('a-ann', 'jira'),
      (await store.oauthTokens.findAccessToken('a-bob', 'jira'))?.subject ?? null,
      (
        await store.oauthTokens.rotateRefreshToken({
          presentedHash: 'r-bob',
          clientId: 'cli',
          now: new Date('2026-01-01T00:00:00.000Z'),
          next: { tokenId: '00000000-0000-4000-8000-000000000009', tokenHash: 'r2' },
          access: { tokenHash: 'a2', expiresAt: new Date('2026-01-01T01:00:00.000Z') },
        })
      ).outcome,
      (
        await store.oauthTokens.rotateRefreshToken({
          presentedHash: 'r-ann',
          clientId: 'cli',
          now: new Date('2026-01-01T00:00:00.000Z'),
          next: { tokenId: '00000000-0000-4000-8000-000000000008', tokenHash: 'r3' },
          access: { tokenHash: 'a3', expiresAt: new Date('2026-01-01T01:00:00.000Z') },
        })
      ).outcome,
    ],
  },
];
