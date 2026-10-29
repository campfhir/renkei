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
    evidence: { quotes: [n] },
    suggested_action: n === 1 ? { tool: 'jira_create_issue', args: { summary: 's' } } : null,
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
    name: 'own and tenant-wide only',
    fixture,
    run: async (store) => [
      await store.actionableItems.findVisible('ann', id(1)),
      (await store.actionableItems.findVisible('ann', id(2)))?.ownerSubject,
      await store.actionableItems.findVisible('ann', id(4)),
      await store.actionableItems.findVisible('ann', id(99)),
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
  {
    method: 'actionableItems.listVisible',
    name: 'narrowed to one status',
    fixture,
    run: async (store) => [
      ids(
        await store.actionableItems.listVisible('ann', {
          limit: 10,
          includeArchived: true,
          status: 'suggested',
        })
      ),
      ids(
        await store.actionableItems.listVisible('ann', {
          limit: 10,
          includeArchived: false,
          status: 'executed',
        })
      ),
    ],
  },
  {
    method: 'actionableItems.create',
    name: 'an owned info card and a tenant-wide suggestion, readable after',
    fixture,
    run: async (store) => {
      await store.actionableItems.create({
        id: id(20),
        source: 'mcp',
        kind: 'info',
        title: 'Morning',
        summary: 'All quiet',
        evidence: {},
        suggestedAction: null,
        ownerSubject: 'ann',
        createdBy: 'ann',
        createdByAgentId: id(101),
      });
      await store.actionableItems.create({
        id: id(21),
        source: 'webex',
        title: 'Captured',
        summary: 'text',
        evidence: { provider: 'webex' },
        suggestedAction: { tool: 'jira_create_issue', args: { summary: 'x' } },
        ownerSubject: null,
        createdBy: null,
        createdByAgentId: null,
      });
      const visible = async (subject: string, n: number) => {
        const card = await store.actionableItems.findVisible(subject, id(n));
        return card ? { ...card, createdAt: undefined } : null;
      };
      return [await visible('ann', 20), await visible('bob', 20), await visible('bob', 21)];
    },
  },
  {
    method: 'actionableItems.updateOwnCreated',
    name: 'own MCP-created suggested cards only',
    fixture: {
      ...fixture,
      actionable_items: [
        ...fixture.actionable_items,
        { ...item(7, 6, { owner: 'ann' }), created_by: 'ann' },
        { ...item(8, 6, { owner: 'ann', status: 'dismissed' }), created_by: 'ann' },
      ],
    },
    run: async (store) => [
      await store.actionableItems.updateOwnCreated('ann', id(7), {
        title: 'new',
        evidence: { a: 1 },
      }),
      await store.actionableItems.updateOwnCreated('ann', id(2), { title: 'pipeline' }),
      await store.actionableItems.updateOwnCreated('ann', id(8), { title: 'decided' }),
      await store.actionableItems.updateOwnCreated('bob', id(7), { title: 'not mine' }),
      (await store.actionableItems.findVisible('ann', id(7)))?.title,
      (await store.actionableItems.findVisible('ann', id(7)))?.evidence,
      (await store.actionableItems.findVisible('ann', id(7)))?.summary,
    ],
  },
  {
    method: 'actionableItems.dismissOwn',
    name: 'own suggested cards once; tenant-wide and others’ refused',
    fixture,
    run: async (store) => [
      await store.actionableItems.dismissOwn('ann', id(2)),
      await store.actionableItems.dismissOwn('ann', id(2)),
      await store.actionableItems.dismissOwn('ann', id(3)),
      await store.actionableItems.dismissOwn('ann', id(4)),
      ids(await store.actionableItems.listVisible('ann', { limit: 10, includeArchived: false })),
      (await store.actionableItems.findVisible('ann', id(2)))?.status,
    ],
  },
  {
    method: 'actionableItems.archiveOwnDecided',
    name: 'own decided unarchived cards only',
    fixture,
    run: async (store) => [
      await store.actionableItems.archiveOwnDecided('ann', id(2)),
      await store.actionableItems.archiveOwnDecided('ann', id(6)),
      await store.actionableItems.archiveOwnDecided('ann', id(6)),
      await store.actionableItems.archiveOwnDecided('ann', id(5)),
      ids(await store.actionableItems.listVisible('ann', { limit: 10, includeArchived: false })),
    ],
  },
  {
    method: 'actionableItems.setRelatedEvidence',
    name: 'merged into a suggested card, other keys kept; a decided card is left alone',
    fixture,
    run: async (store) => {
      const related = [{ provider: 'jira', refId: 'ENG-9', excerpt: 'x', distance: 0.25 }];
      const suggested = await store.actionableItems.setRelatedEvidence(id(2), related, 3);
      const again = await store.actionableItems.setRelatedEvidence(id(2), [], 0);
      const decided = await store.actionableItems.setRelatedEvidence(id(6), related, 1);
      const missing = await store.actionableItems.setRelatedEvidence(id(99), related, 1);
      return {
        suggested,
        again,
        decided,
        missing,
        two: (await store.actionableItems.findVisible('ann', id(2)))?.evidence,
        six: (await store.actionableItems.findVisible('ann', id(6)))?.evidence,
      };
    },
  },
];
