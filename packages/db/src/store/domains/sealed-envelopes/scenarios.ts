import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { SealedEnvelopeColumn } from './types';

const id = (n: number) => `00000000-0000-4000-8000-18${String(n).padStart(10, '0')}`;

const connectors: SealedEnvelopeColumn = {
  table: 'connector_configs',
  idColumns: ['connector'],
  column: 'encrypted_secrets',
};
const rules: SealedEnvelopeColumn = {
  table: 'code_service_image_rules',
  idColumns: ['id'],
  column: 'registry_sealed',
};

const fixture = {
  connector_configs: [
    { connector: 'zoom', encrypted_secrets: 'v1.old' },
    { connector: 'github', encrypted_secrets: 'v2.cur.x' },
    { connector: 'jira', encrypted_secrets: 'v2.prev.x' },
    { connector: 'atlassian', encrypted_secrets: 'v1.a' },
    { connector: 'box', encrypted_secrets: 'v2_cur.x' },
  ],
  code_service_image_rules: [
    { id: id(3), pattern: 'c', registry_sealed: 'reg1.v1.c' },
    { id: id(1), pattern: 'a', registry_sealed: 'reg1.v2.cur.a' },
    { id: id(2), pattern: 'b', registry_sealed: null },
    { id: id(4), pattern: 'd', registry_sealed: 'reg1.v1.d' },
  ],
};

export const sealedEnvelopeScenarios: Scenario<DataStore>[] = [
  {
    method: 'sealedEnvelopes.pageNotLike',
    name: 'not-current values in key order, paged after the last key; nulls skipped',
    fixture,
    run: async (store) => {
      const first = await store.sealedEnvelopes.pageNotLike(connectors, 'v2.cur.%', null, 2);
      const second = await store.sealedEnvelopes.pageNotLike(
        connectors,
        'v2.cur.%',
        first[first.length - 1].id,
        2
      );
      return [
        first,
        second,
        await store.sealedEnvelopes.pageNotLike(connectors, 'v2.cur.%', ['zoom'], 2),
        await store.sealedEnvelopes.pageNotLike(rules, 'reg1.v2.cur.%', null, 10),
        await store.sealedEnvelopes.pageNotLike(rules, 'reg1.v2.cur.%', [id(3)], 10),
      ];
    },
  },
  {
    method: 'sealedEnvelopes.replaceIfUnchanged',
    name: 'swaps only while the stored value is as read',
    fixture,
    run: async (store) => [
      await store.sealedEnvelopes.replaceIfUnchanged(connectors, ['zoom'], 'v1.old', 'v2.cur.new'),
      await store.sealedEnvelopes.replaceIfUnchanged(connectors, ['zoom'], 'v1.old', 'v2.cur.b'),
      await store.sealedEnvelopes.replaceIfUnchanged(rules, [id(3)], 'reg1.v1.c', 'reg1.v2.cur.c'),
      await store.sealedEnvelopes.pageNotLike(connectors, 'v2.cur.%', null, 10),
      await store.sealedEnvelopes.pageNotLike(rules, 'reg1.v2.cur.%', null, 10),
    ],
  },
];
