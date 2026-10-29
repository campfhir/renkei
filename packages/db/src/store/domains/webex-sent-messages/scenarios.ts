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
  {
    method: 'webexSentMessages.pruneOlderThan',
    name: 'old entries go oldest first (ties by id) up to the limit; recent stay',
    fixture: {
      webex_sent_messages: [
        { message_id: 'm-b', account_id: 'acct', created_at: new Date(Date.UTC(2020, 0, 1)) },
        { message_id: 'm-a', account_id: null, created_at: new Date(Date.UTC(2020, 0, 1)) },
        { message_id: 'm-c', account_id: 'acct', created_at: new Date(Date.UTC(2021, 0, 1)) },
        { message_id: 'm-new', account_id: 'acct', created_at: new Date(Date.UTC(2099, 0, 1)) },
      ],
    },
    run: async (store) => {
      const present = async () => {
        const out: string[] = [];
        for (const id of ['m-a', 'm-b', 'm-c', 'm-new']) {
          if (await store.webexSentMessages.find(id)) out.push(id);
        }
        return out;
      };
      const first = await store.webexSentMessages.pruneOlderThan(7, 1);
      const afterFirst = await present();
      const rest = await store.webexSentMessages.pruneOlderThan(7, 10);
      return { first, afterFirst, rest, afterAll: await present() };
    },
  },
];
