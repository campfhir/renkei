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
];
