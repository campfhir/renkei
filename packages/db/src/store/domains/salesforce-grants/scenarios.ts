import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const EXPIRES = '2099-01-01T00:00:00.000Z';

function grant(provider: string, account: string, subject: string | null, extra = {}) {
  return {
    provider,
    provider_account_id: account,
    subject,
    client_id: 'client',
    display_name: `${subject} at ${account}`,
    encrypted_access_token: 'sealed',
    encrypted_refresh_token: 'sealed',
    expires_at: EXPIRES,
    ...extra,
  };
}

const fixture = {
  provider_grants: [
    grant('salesforce', '00D2/005b', 'ann', {
      metadata: JSON.stringify({ connector: 'uat', instanceUrl: 'https://uat.example', n: [1] }),
      requested_scopes: ['api', 'refresh_token'],
    }),
    grant('salesforce', '00D1/005a', 'ann'),
    grant('salesforce-admin', '00D1/005c', 'ann', { requested_scopes: ['api'] }),
    grant('salesforce', '00D1/005d', 'bob'),
    grant('salesforce', '00D3/005e', null),
  ],
};

export const salesforceGrantScenarios: Scenario<DataStore>[] = [
  {
    method: 'salesforceGrants.listConnections',
    name: 'one person’s grants for one provider, by account, metadata as stored',
    fixture,
    run: async (store) => [
      await store.salesforceGrants.listConnections('ann', 'salesforce'),
      await store.salesforceGrants.listConnections('ann', 'salesforce-admin'),
      await store.salesforceGrants.listConnections('nobody', 'salesforce'),
    ],
  },
];
