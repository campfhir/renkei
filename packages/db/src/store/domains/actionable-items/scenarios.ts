import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function item(
  n: number,
  minute: number,
  fields: { owner?: string | null; status?: string; archived?: boolean; agent?: number } = {}
) {
  return {
    id: id(n),
    source: 'jira',
    kind: n === 3 ? 'info' : 'suggestion',
    status: fields.status ?? 'suggested',
    title: `card ${n}`,
    summary: `summary ${n}`,
    evidence: JSON.stringify({ quotes: [n] }),
    suggested_action:
      n === 1 ? JSON.stringify({ tool: 'jira_create_issue', args: { summary: 's' } }) : null,
    owner_subject: fields.owner ?? null,
    created_by_agent_id: fields.agent ? id(100 + fields.agent) : null,
    archived_at: fields.archived ? at(minute + 1) : null,
    archived_by: fields.archived ? 'ann' : null,
    created_at: at(minute),
  };
}

const fixture = {
  agents: [{ id: id(101), name: 'Triage', owner_subject: 'ann' }],
  actionable_items: [
    item(1, 1, { agent: 1 }),
    item(2, 3, { owner: 'ann' }),
    item(3, 3),
    item(4, 5, { owner: 'bob' }),
    item(5, 2, { status: 'executed', archived: true }),
    item(6, 4, { status: 'failed', owner: 'ann' }),
  ],
};

const ids = (items: { id: string }[]) => items.map((i) => i.id);

export const actionableItemScenarios: Scenario<DataStore>[] = [
  {
    method: 'actionableItems.listVisible',
    name: 'tenant-wide and own, newest first, ties by id, paged, archived on request',
    fixture,
    run: async (store) => [
      await store.actionableItems.listVisible('ann', { limit: 10, includeArchived: false }),
      ids(await store.actionableItems.listVisible('ann', { limit: 10, includeArchived: true })),
      ids(
        await store.actionableItems.listVisible('ann', {
          limit: 2,
          offset: 1,
          includeArchived: true,
        })
      ),
      ids(await store.actionableItems.listVisible('bob', { limit: 10, includeArchived: false })),
      ids(
        await store.actionableItems.listVisible('cy', {
          limit: 1,
          offset: 9,
          includeArchived: true,
        })
      ),
    ],
  },
  {
    method: 'actionableItems.findVisible',
    name: 'own and tenant-wide only; a malformed id is refused',
    fixture,
    run: async (store) => [
      await store.actionableItems.findVisible('ann', id(1)),
      (await store.actionableItems.findVisible('ann', id(2)))?.ownerSubject,
      await store.actionableItems.findVisible('ann', id(4)),
      await store.actionableItems.findVisible('ann', id(99)),
      await store.actionableItems.findVisible('ann', 'not-a-uuid').then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      ),
    ],
  },
  {
    method: 'actionableItems.archive',
    name: 'archives as the given person',
    fixture,
    run: async (store) => {
      await store.actionableItems.archive(id(6), 'ann');
      const card = await store.actionableItems.findVisible('ann', id(6));
      return {
        archived: card?.archivedAt !== null,
        feed: ids(
          await store.actionableItems.listVisible('ann', { limit: 10, includeArchived: false })
        ),
      };
    },
  },
  {
    method: 'actionableItems.unarchive',
    name: 'visible cards only, counting changes',
    fixture,
    run: async (store) => [
      await store.actionableItems.unarchive('ann', id(5)),
      await store.actionableItems.unarchive('ann', id(4)),
      await store.actionableItems.unarchive('ann', id(99)),
      (await store.actionableItems.findVisible('ann', id(5)))?.archivedAt,
    ],
  },
  {
    method: 'actionableItems.decide',
    name: 'only a suggested card; dismissing archives it',
    fixture,
    run: async (store) => {
      const counts = [
        await store.actionableItems.decide(id(2), 'ann', 'dismissed'),
        await store.actionableItems.decide(id(2), 'ann', 'approved'),
        await store.actionableItems.decide(id(1), 'ann', 'approved'),
        await store.actionableItems.decide(id(5), 'ann', 'approved'),
      ];
      const dismissed = await store.actionableItems.findVisible('ann', id(2));
      const approved = await store.actionableItems.findVisible('ann', id(1));
      return {
        counts,
        dismissed: [
          dismissed?.status,
          dismissed?.archivedAt !== null,
          dismissed?.decidedAt !== null,
        ],
        approved: [approved?.status, approved?.archivedAt, approved?.decidedAt !== null],
      };
    },
  },
  {
    method: 'actionableItems.recordOutcome',
    name: 'final status and JSON result',
    fixture,
    run: async (store) => {
      await store.actionableItems.recordOutcome(id(1), 'executed', { issueKey: 'A-1', url: 'u' });
      const card = await store.actionableItems.findVisible('ann', id(1));
      return [card?.status, card?.result];
    },
  },
];
