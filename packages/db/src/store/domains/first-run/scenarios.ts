import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

export const firstRunScenarios: Scenario<DataStore>[] = [
  {
    method: 'firstRun.identityProviderConfigured',
    name: 'no provider yet',
    run: async (store) => store.firstRun.identityProviderConfigured(),
  },
  {
    method: 'firstRun.identityProviderConfigured',
    name: 'a provider is configured',
    fixture: {
      oidc_config: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          client_id: 'renkei',
          client_secret: 'enc',
          issuer: 'https://idp.example.test',
        },
      ],
    },
    run: async (store) => store.firstRun.identityProviderConfigured(),
  },
];
