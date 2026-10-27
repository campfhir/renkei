import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const fixture = {
  webex_sent_messages: [{ message_id: 'm1', account_id: 'acct' }],
};

export const webexSentMessageScenarios: Scenario<DataStore>[] = [
  {
    method: 'webexSentMessages.find',
    name: 'on the ledger or not',
    fixture,
    run: async (store) => [
      await store.webexSentMessages.find('m1'),
      await store.webexSentMessages.find('m2'),
    ],
  },
  {
    method: 'webexSentMessages.record',
    name: 'new ids land; a repeat keeps the first account',
    fixture,
    run: async (store) => {
      await store.webexSentMessages.record('m2', null);
      await store.webexSentMessages.record('m1', 'other');
      return [await store.webexSentMessages.find('m1'), await store.webexSentMessages.find('m2')];
    },
  },
];
