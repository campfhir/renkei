import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const stored = {
  delegate_signing_keys: [
    {
      id: '00000000-0000-4000-8000-140000000001',
      public_key: 'pub-1',
      sealed_private_key: 'sealed-1',
    },
  ],
};

export const delegateSigningKeyScenarios: Scenario<DataStore>[] = [
  {
    method: 'delegateSigningKeys.find',
    name: 'the stored key; null before any',
    fixture: stored,
    run: async (store) => {
      const found = await store.delegateSigningKeys.find();
      return found;
    },
  },
  {
    method: 'delegateSigningKeys.find',
    name: 'null on a fresh deployment',
    run: async (store) => store.delegateSigningKeys.find(),
  },
  {
    method: 'delegateSigningKeys.insertIfAbsent',
    name: 'the first write wins; a later one is ignored',
    run: async (store) => [
      await store.delegateSigningKeys.insertIfAbsent({ publicKey: 'a', sealedPrivateKey: 'sa' }),
      await store.delegateSigningKeys.insertIfAbsent({ publicKey: 'b', sealedPrivateKey: 'sb' }),
      await store.delegateSigningKeys.find(),
    ],
  },
  {
    method: 'delegateSigningKeys.insertIfAbsent',
    name: 'a stored key stays',
    fixture: stored,
    run: async (store) => [
      await store.delegateSigningKeys.insertIfAbsent({ publicKey: 'b', sealedPrivateKey: 'sb' }),
      await store.delegateSigningKeys.find(),
    ],
  },
];
