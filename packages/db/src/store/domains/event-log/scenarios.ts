import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-e${String(n).padStart(11, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const fixture = {
  events: [
    {
      id: id(1),
      source: 'jira',
      type: 'issue_updated',
      status: 'pending',
      attempts: 0,
      payload: { accountId: 'acct-1' },
      created_at: at(1),
    },
    {
      id: id(2),
      source: 'zoom',
      type: 'recording',
      status: 'pending',
      attempts: 2,
      payload: { payload: { object: { host_email: 'h@example.test' } } },
      created_at: at(4),
    },
    {
      id: id(3),
      source: 'internal',
      type: 'agent.run',
      status: 'skipped',
      payload: { ownerSubject: 'ann' },
      created_at: at(4),
    },
    {
      id: id(4),
      source: 'graph',
      type: 'mail',
      status: 'processed',
      payload: {},
      created_at: at(2),
    },
  ],
  events_dead_letters: [
    { id: id(5), source: 'jira', type: 'x', attempts: 5, payload: { a: 1 }, created_at: at(3) },
    { id: id(6), source: 'jira', type: 'y', attempts: 5, payload: '"text"', created_at: at(3) },
  ],
};

export const eventLogScenarios: Scenario<DataStore>[] = [
  {
    method: 'eventLog.listRecent',
    name: 'newest first, ties by id desc, bounded, payloads as stored',
    fixture,
    run: async (store) => [
      await store.eventLog.listRecent(200),
      (await store.eventLog.listRecent(2)).map((e) => e.id),
    ],
  },
  {
    method: 'eventLog.listRecent',
    name: 'an empty queue',
    run: (store) => store.eventLog.listRecent(200),
  },
  {
    method: 'eventLog.listRecentDeadLetters',
    name: 'newest first, ties by id desc, failed status, bounded',
    fixture,
    run: async (store) => [
      await store.eventLog.listRecentDeadLetters(200),
      await store.eventLog.listRecentDeadLetters(1),
    ],
  },
];
