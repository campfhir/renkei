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
  {
    method: 'providerGrants.findSealed',
    name: 'tokens as stored; another provider or account reads null',
    fixture,
    run: async (store) => [
      await store.providerGrants.findSealed('zoom', 'z1'),
      await store.providerGrants.findSealed('microsoft', 'ms2'),
      await store.providerGrants.findSealed('zoom', 'a1'),
    ],
  },
  {
    method: 'providerGrants.upsertSealed',
    name: 'insert, reconnect replacing or keeping the refresh token',
    fixture,
    run: async (store) => {
      const input = {
        accountId: 'n1',
        clientId: 'client-n',
        displayName: 'New',
        subject: 'ann',
        encryptedAccessToken: 'acc-1',
        encryptedRefreshToken: 'ref-1',
        keepStoredRefreshToken: false,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        requestedScopes: ['x'],
        grantedScopes: null,
        metadata: { site: 'a' },
      };
      await store.providerGrants.upsertSealed('github', input);
      const first = await store.providerGrants.findSealed('github', 'n1');
      await store.providerGrants.upsertSealed('github', {
        ...input,
        displayName: 'Renamed',
        subject: 'bob',
        encryptedAccessToken: 'acc-2',
        encryptedRefreshToken: 'ref-ignored',
        keepStoredRefreshToken: true,
        grantedScopes: ['x'],
      });
      const kept = await store.providerGrants.findSealed('github', 'n1');
      await store.providerGrants.upsertSealed('github', {
        ...input,
        encryptedAccessToken: 'acc-3',
        encryptedRefreshToken: 'ref-3',
      });
      return { first, kept, replaced: await store.providerGrants.findSealed('github', 'n1') };
    },
  },
  {
    method: 'providerGrants.updateSealedTokens',
    name: 'scopes only when given; a missing grant changes nothing',
    fixture,
    run: async (store) => [
      await store.providerGrants.updateSealedTokens('zoom', 'z1', {
        encryptedAccessToken: 'a2',
        encryptedRefreshToken: 'r2',
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        grantedScopes: null,
      }),
      await store.providerGrants.findSealed('zoom', 'z1'),
      await store.providerGrants.updateSealedTokens('atlassian', 'a1', {
        encryptedAccessToken: 'a3',
        encryptedRefreshToken: 'r3',
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        grantedScopes: ['read'],
      }),
      await store.providerGrants.findSealed('atlassian', 'a1'),
      await store.providerGrants.updateSealedTokens('zoom', 'none', {
        encryptedAccessToken: 'a',
        encryptedRefreshToken: 'r',
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        grantedScopes: null,
      }),
    ],
  },
  {
    method: 'providerGrants.delete',
    name: 'one grant; the others stay',
    fixture,
    run: async (store) => [
      await store.providerGrants.delete('atlassian', 'a1'),
      await store.providerGrants.delete('atlassian', 'a1'),
      (await store.providerGrants.listForSubject('ann', { provider: 'atlassian' })).map(
        (g) => g.accountId
      ),
    ],
  },
  {
    method: 'providerGrants.acquireRefreshLock',
    name: 'one holder at a time, per grant',
    run: async (store) => {
      const at = new Date('2026-01-01T00:00:00.000Z');
      return [
        await store.providerGrants.acquireRefreshLock('zoom', 'z1', at),
        await store.providerGrants.acquireRefreshLock('zoom', 'z1', at),
        await store.providerGrants.acquireRefreshLock('zoom', 'z2', at),
        await store.providerGrants.findRefreshLock('zoom', 'z1'),
      ];
    },
  },
  {
    method: 'providerGrants.findRefreshLock',
    name: 'the lock time, or null',
    fixture: {
      provider_refresh_locks: [
        { provider: 'zoom', account_id: 'z1', locked_at: '2026-01-01T00:05:00.000Z' },
      ],
    },
    run: async (store) => [
      await store.providerGrants.findRefreshLock('zoom', 'z1'),
      await store.providerGrants.findRefreshLock('zoom', 'z2'),
    ],
  },
  {
    method: 'providerGrants.releaseRefreshLock',
    name: 'released, then free to take again',
    fixture: {
      provider_refresh_locks: [
        { provider: 'zoom', account_id: 'z1', locked_at: '2026-01-01T00:05:00.000Z' },
        { provider: 'zoom', account_id: 'z2', locked_at: '2026-01-01T00:05:00.000Z' },
      ],
    },
    run: async (store) => {
      await store.providerGrants.releaseRefreshLock('zoom', 'z1');
      await store.providerGrants.releaseRefreshLock('zoom', 'none');
      return [
        await store.providerGrants.findRefreshLock('zoom', 'z1'),
        await store.providerGrants.findRefreshLock('zoom', 'z2'),
        await store.providerGrants.acquireRefreshLock(
          'zoom',
          'z1',
          new Date('2026-01-01T00:06:00.000Z')
        ),
      ];
    },
  },
  {
    method: 'providerGrants.findByMetadataText',
    name: 'exact match on one provider, first by account id; misses and other keys',
    fixture: {
      provider_grants: [
        grant('zoom', 'z9', 'ann', { metadata: JSON.stringify({ email: 'host@x.test' }) }),
        grant('zoom', 'z2', 'bob', { metadata: JSON.stringify({ email: 'host@x.test' }) }),
        grant('zoom', 'z3', 'carol', { metadata: JSON.stringify({ email: 'Host@x.test' }) }),
        grant('zoom', 'z4', 'dan', { metadata: JSON.stringify({ other: 'host@x.test' }) }),
        grant('webex', 'w1', 'erin', { metadata: JSON.stringify({ email: 'solo@x.test' }) }),
        grant('zoom', 'z5', 'fay'),
      ],
    },
    run: async (store) => [
      await store.providerGrants.findByMetadataText('zoom', 'email', 'host@x.test'),
      await store.providerGrants.findByMetadataText('zoom', 'email', 'Host@x.test'),
      await store.providerGrants.findByMetadataText('zoom', 'email', 'solo@x.test'),
      await store.providerGrants.findByMetadataText('webex', 'email', 'solo@x.test'),
      await store.providerGrants.findByMetadataText('zoom', 'email', 'nobody@x.test'),
    ],
  },
  {
    method: 'providerGrants.findByHolderEmail',
    name: "the holder's grant on that provider, first by account id; others and unknown emails miss",
    fixture: {
      identities: [
        { subject: 'ann', email: 'ann@x.test' },
        { subject: 'bob', email: 'bob@x.test' },
        { subject: 'carol', email: 'carol@x.test' },
      ],
      provider_grants: [
        grant('webex-user', 'w9', 'ann'),
        grant('webex-user', 'w2', 'ann'),
        grant('webex-user', 'w5', 'bob'),
        grant('zoom', 'z1', 'carol'),
        grant('webex-user', 'w0', null),
      ],
    },
    run: async (store) => [
      await store.providerGrants.findByHolderEmail('webex-user', 'ann@x.test'),
      await store.providerGrants.findByHolderEmail('webex-user', 'bob@x.test'),
      await store.providerGrants.findByHolderEmail('webex-user', 'carol@x.test'),
      await store.providerGrants.findByHolderEmail('webex-user', 'Ann@x.test'),
      await store.providerGrants.findByHolderEmail('webex-user', 'nobody@x.test'),
    ],
  },
];
