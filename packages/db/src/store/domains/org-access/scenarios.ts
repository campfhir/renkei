import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const wid = (n: number) => `00000000-0000-4000-8000-3a${String(n).padStart(10, '0')}`;

const grant = (
  provider: string,
  accountId: string,
  subject: string | null,
  displayName: string,
  metadata: { [key: string]: string } = {}
) => ({
  provider,
  provider_account_id: accountId,
  subject,
  display_name: displayName,
  client_id: 'client',
  encrypted_access_token: 'sealed-a',
  encrypted_refresh_token: 'sealed-r',
  expires_at: '2026-06-01T00:00:00.000Z',
  metadata,
  created_at: '2026-01-01T00:00:00.000Z',
});

const fixture = {
  provider_grants: [
    grant('microsoft', 'acct-2', 'ann', 'Ann M'),
    grant('atlassian', 'acct-9', 'bob', 'Bob', {
      cloudId: 'c1',
      siteUrl: 'https://x.atlassian.net',
    }),
    grant('atlassian', 'acct-1', 'ann', 'Ann A', { cloudId: 'c1' }),
    grant('atlassian-jsm', 'acct-1', 'ann', 'Ann J'),
    grant('zoom', 'acct-3', null, 'Legacy'),
  ],
  oauth_clients: [
    { client_id: 'client-1', client_secret_hash: 'h', redirect_uris: ['https://x.test'] },
  ],
  oauth_access_tokens: [
    { token_hash: 'a1', client_id: 'client-1', subject: 'ann', expires_at: '2030-01-01T00:00:00Z' },
    { token_hash: 'a2', client_id: 'client-1', subject: 'bob', expires_at: '2030-01-01T00:00:00Z' },
  ],
  oauth_refresh_tokens: [
    {
      token_hash: 'r1',
      token_id: '00000000-0000-4000-8000-3b0000000001',
      client_id: 'client-1',
      subject: 'ann',
      expires_at: '2030-01-01T00:00:00Z',
    },
  ],
  user_encryption_keys: [
    { subject: 'zed', salt: 's', mode: 'held' },
    { subject: 'ann', salt: 's' },
  ],
  content_watches: [
    {
      id: wid(2),
      provider: 'microsoft',
      subject: 'ann',
      account_id: 'acct-2',
      scope_type: 'drive',
      scope_key: 'd1',
      scope_label: 'Shared',
      sync_status: 'idle',
    },
    {
      id: wid(1),
      provider: 'atlassian',
      subject: 'ann',
      account_id: 'acct-1',
      scope_type: 'space',
      scope_key: 'ENG',
      enabled: false,
    },
    {
      id: wid(3),
      provider: 'atlassian',
      subject: 'bob',
      account_id: 'acct-9',
      scope_type: 'project',
      scope_key: 'OPS',
    },
  ],
};

export const orgAccessScenarios: Scenario<DataStore>[] = [
  {
    method: 'orgAccess.listGrants',
    name: 'by provider then account, ownerless included',
    fixture,
    run: (store) => store.orgAccess.listGrants(),
  },
  {
    method: 'orgAccess.listGrants',
    name: 'none',
    run: (store) => store.orgAccess.listGrants(),
  },
  {
    method: 'orgAccess.listGrantsOfProviders',
    name: 'only the asked providers; none asked',
    fixture,
    run: async (store) => [
      (await store.orgAccess.listGrantsOfProviders(['atlassian', 'atlassian-jsm', 'nope'])).map(
        (g) => [g.provider, g.accountId, g.metadata]
      ),
      await store.orgAccess.listGrantsOfProviders([]),
    ],
  },
  {
    method: 'orgAccess.grantsForAccounts',
    name: 'every provider’s grant of these accounts; none asked',
    fixture,
    run: async (store) => [
      (await store.orgAccess.grantsForAccounts(['acct-1', 'acct-3', 'missing'])).map((g) => [
        g.provider,
        g.accountId,
        g.subject,
      ]),
      await store.orgAccess.grantsForAccounts([]),
    ],
  },
  {
    method: 'orgAccess.firstGrantOf',
    name: 'first by provider, and a stranger',
    fixture,
    run: async (store) => [
      (await store.orgAccess.firstGrantOf('ann'))?.displayName,
      await store.orgAccess.firstGrantOf('nobody'),
    ],
  },
  {
    method: 'orgAccess.revokeGrant',
    name: 'the grant and its owner’s tokens go; a miss and an ownerless grant',
    fixture,
    run: async (store) => {
      const revoked = await store.orgAccess.revokeGrant('atlassian', 'acct-1');
      const again = await store.orgAccess.revokeGrant('atlassian', 'acct-1');
      const legacy = await store.orgAccess.revokeGrant('zoom', 'acct-3');
      return {
        revoked,
        again,
        legacy: legacy?.subject,
        left: (await store.orgAccess.listGrants()).map((g) => [g.provider, g.accountId]),
        // What is left of each subject's tokens, read by revoking them.
        ann: await store.sessions.revokeAll('ann'),
        bob: await store.sessions.revokeAll('bob'),
      };
    },
  },
  {
    method: 'orgAccess.listKeyHolders',
    name: 'by subject, mode defaulted',
    fixture,
    run: (store) => store.orgAccess.listKeyHolders(),
  },
  {
    method: 'orgAccess.listContentWatches',
    name: 'by provider then id, defaults filled',
    fixture,
    run: (store) => store.orgAccess.listContentWatches(),
  },
];
