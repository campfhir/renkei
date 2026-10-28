import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function grant(provider: string, account: string, subject: string | null, scopes: string[] | null) {
  return {
    provider,
    provider_account_id: account,
    subject,
    client_id: 'c',
    display_name: `${provider} ${account}`,
    encrypted_access_token: 'enc',
    encrypted_refresh_token: 'enc',
    expires_at: new Date(Date.UTC(2026, 0, 2)),
    granted_scopes: scopes,
  };
}

const fixture = {
  provider_grants: [
    grant('microsoft', 'm-2', 'ann', ['Mail.Send']),
    grant('microsoft', 'm-1', 'ann', null),
    grant('webex-user', 'w-1', 'ann', ['spark:messages_write']),
    grant('atlassian', 'a-9', 'ann', []),
    grant('atlassian', 'a-3', 'ann', []),
    grant('atlassian', 'a-1', 'bob', []),
    grant('atlassian', 'a-0', null, []),
  ],
  agents: [
    { id: id(3), name: 'beta', owner_subject: 'ann' },
    { id: id(1), name: 'alpha', owner_subject: 'ann' },
    { id: id(2), name: 'beta 2', owner_subject: 'ann' },
    { id: id(4), name: 'zed', owner_subject: 'bob' },
  ],
};

export const personalAccountScenarios: Scenario<DataStore>[] = [
  {
    method: 'personalAccount.grantScopes',
    name: 'own grants of the asked providers, ordered',
    fixture,
    run: async (store) => [
      await store.personalAccount.grantScopes('ann', ['microsoft', 'webex-user']),
      await store.personalAccount.grantScopes('ann', []),
      await store.personalAccount.grantScopes('cy', ['microsoft']),
    ],
  },
  {
    method: 'personalAccount.providerAccountId',
    name: 'the lowest own account id, or null',
    fixture,
    run: async (store) => [
      await store.personalAccount.providerAccountId('ann', 'atlassian'),
      await store.personalAccount.providerAccountId('bob', 'atlassian'),
      await store.personalAccount.providerAccountId('cy', 'atlassian'),
    ],
  },
  {
    method: 'personalAccount.ownedAgentNames',
    name: 'by name under collation',
    fixture,
    run: async (store) => [
      await store.personalAccount.ownedAgentNames('ann'),
      await store.personalAccount.ownedAgentNames('cy'),
    ],
  },
];
