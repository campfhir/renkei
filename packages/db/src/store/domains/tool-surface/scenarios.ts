import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = (minute: number, ms = 0) => new Date(Date.UTC(2026, 0, 1, 0, minute, 0, ms));

function grant(account: string, subject: string, updatedAt: Date) {
  return {
    provider: 'atlassian',
    provider_account_id: account,
    client_id: 'client',
    display_name: account,
    subject,
    encrypted_access_token: 'a',
    encrypted_refresh_token: 'r',
    expires_at: at(500),
    updated_at: updatedAt,
  };
}

export const toolSurfaceScenarios: Scenario<DataStore>[] = [
  {
    method: 'toolSurface.version',
    name: 'nothing stamped is null',
    fixture: {},
    run: (store) => store.toolSurface.version('ann'),
  },
  {
    method: 'toolSurface.version',
    name: 'the newest of own and org-wide rows; another person’s rows are ignored',
    fixture: {
      provider_grants: [grant('a1', 'ann', at(3, 250)), grant('b1', 'bob', at(40))],
      settings: [{ key: 'k', value: 1, updated_at: at(2) }],
      identities: [
        { subject: 'ann', email: 'ann@x.test', updated_at: at(4, 7) },
        { subject: 'bob', email: 'bob@x.test', updated_at: at(50) },
      ],
    },
    run: async (store) => [
      await store.toolSurface.version('ann'),
      await store.toolSurface.version('bob'),
      await store.toolSurface.version('cy'),
    ],
  },
];
