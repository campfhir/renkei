import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { AgentDraftRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-f${String(n).padStart(11, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const agents = [
  { id: id(1), owner_subject: 'ann', name: 'A' },
  { id: id(2), owner_subject: 'bob', name: 'B' },
];

function draft(
  n: number,
  agent: number | null,
  owner: string,
  minute: number,
  extra: Record<string, unknown> = {}
) {
  return {
    id: id(n),
    agent_id: agent === null ? null : id(agent),
    owner_subject: owner,
    request: JSON.stringify({ text: `draft ${n}` }),
    created_at: at(minute),
    ...extra,
  };
}

const fixture = {
  agents,
  agent_drafts: [
    draft(11, 1, 'ann', 1, { status: 'succeeded', result: JSON.stringify({ name: 'x' }) }),
    draft(12, 1, 'ann', 3, { status: 'succeeded', consumed_at: at(4) }),
    draft(13, 1, 'ann', 2, { status: 'failed', error: 'no' }),
    draft(14, null, 'ann', 5, { status: 'succeeded' }),
    draft(15, null, 'ann', 5, { status: 'succeeded' }),
    draft(16, null, 'ann', 6, { status: 'queued' }),
    draft(17, 2, 'bob', 7, { status: 'succeeded' }),
  ],
};

function settled(row: AgentDraftRecord | null) {
  return (
    row && {
      ...row,
      finishedAt: row.finishedAt ? 'set' : null,
      consumedAt: row.consumedAt ? 'set' : null,
    }
  );
}

export const agentDraftScenarios: Scenario<DataStore>[] = [
  {
    method: 'agentDrafts.create',
    name: 'queued, for an agent or a new one',
    fixture: { agents },
    run: async (store) => {
      const one = await store.agentDrafts.create({
        ownerSubject: 'ann',
        agentId: id(1),
        request: { text: 'hi' },
      });
      const two = await store.agentDrafts.create({
        ownerSubject: 'ann',
        agentId: null,
        request: { text: 'new' },
      });
      const strip = (row: AgentDraftRecord | null) =>
        row && { ...row, id: undefined, createdAt: undefined };
      return [
        strip(await store.agentDrafts.find('ann', one)),
        strip(await store.agentDrafts.find('ann', two)),
      ];
    },
  },
  {
    method: 'agentDrafts.find',
    name: "the owner's draft only",
    fixture,
    run: async (store) => [
      await store.agentDrafts.find('ann', id(11)),
      await store.agentDrafts.find('bob', id(11)),
      await store.agentDrafts.find('ann', id(99)),
    ],
  },
  {
    method: 'agentDrafts.latestReady',
    name: 'newest succeeded and unconsumed, per agent or for a new one',
    fixture,
    run: async (store) => [
      (await store.agentDrafts.latestReady('ann', id(1)))?.id,
      (await store.agentDrafts.latestReady('ann', null))?.id,
      await store.agentDrafts.latestReady('bob', id(1)),
      (await store.agentDrafts.latestReady('bob', id(2)))?.id,
    ],
  },
  {
    method: 'agentDrafts.consume',
    name: "consumed drafts are no longer offered; others' untouched",
    fixture,
    run: async (store) => {
      await store.agentDrafts.consume('ann', id(11));
      await store.agentDrafts.consume('ann', id(17));
      return [
        await store.agentDrafts.latestReady('ann', id(1)),
        settled(await store.agentDrafts.find('bob', id(17))),
      ];
    },
  },
  {
    method: 'agentDrafts.claim',
    name: 'queued to running once',
    fixture,
    run: async (store) => [
      await store.agentDrafts.claim(id(16)),
      await store.agentDrafts.claim(id(16)),
      await store.agentDrafts.claim(id(11)),
      (await store.agentDrafts.find('ann', id(16)))?.attempts,
    ],
  },
  {
    method: 'agentDrafts.finish',
    name: 'succeeded with a result, or failed with the error',
    fixture,
    run: async (store) => {
      await store.agentDrafts.finish(id(16), { status: 'succeeded', result: { name: 'drafted' } });
      await store.agentDrafts.finish(id(13), { status: 'failed', error: 'again', detail: 'trace' });
      return [
        settled(await store.agentDrafts.find('ann', id(16))),
        settled(await store.agentDrafts.find('ann', id(13))),
      ];
    },
  },
  {
    method: 'agentDrafts.delete',
    name: 'removes one draft',
    fixture,
    run: async (store) => {
      await store.agentDrafts.delete(id(15));
      return [
        await store.agentDrafts.find('ann', id(15)),
        (await store.agentDrafts.latestReady('ann', null))?.id,
      ];
    },
  },
];
