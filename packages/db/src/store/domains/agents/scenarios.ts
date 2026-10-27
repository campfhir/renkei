import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { AgentRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-a${String(n).padStart(11, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const FAR = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
const refusal = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : 'threw';

function agent(n: number, owner: string, name: string, minute: number) {
  return {
    id: id(n),
    owner_subject: owner,
    name,
    instructions: `do ${n}`,
    tools: JSON.stringify(['jira_search', `tool_${n}`]),
    review_notes: n === 1 ? JSON.stringify([{ issue: 'check' }]) : null,
    enabled: n % 2 === 1,
    created_at: at(minute),
    updated_at: at(minute),
  };
}

const identities = [
  { subject: 'ann', email: 'ann@example.test', display_name: 'Ann' },
  { subject: 'bob', email: 'bob@example.test', display_name: null },
];

const fixture = {
  identities,
  agents: [
    agent(1, 'ann', 'Alpha', 1),
    agent(2, 'ann', 'beta', 3),
    agent(3, 'ann', 'Gamma', 3),
    agent(4, 'bob', 'Bob agent', 2),
    agent(5, 'carol', 'Carol agent', 4),
  ],
  agent_triggers: [
    {
      id: id(11),
      agent_id: id(1),
      kind: 'schedule',
      config: JSON.stringify({ every: 'day', at: '08:00' }),
      next_run_at: at(100),
      created_at: at(2),
    },
    {
      id: id(12),
      agent_id: id(1),
      kind: 'event',
      event_source: 'jira',
      event_type: 'issue_created',
      config: JSON.stringify({ match: {} }),
      enabled: false,
      last_error: 'boom',
      created_at: at(1),
    },
    { id: id(13), agent_id: id(1), kind: 'api', config: '{}', created_at: at(1) },
    { id: id(14), agent_id: id(4), kind: 'agent', created_at: at(1) },
  ],
  agent_access_grants: [
    {
      id: id(21),
      agent_id: id(4),
      owner_subject: 'bob',
      grantee_subject: 'ann',
      expires_at: null,
      created_at: at(5),
    },
    {
      id: id(22),
      agent_id: id(5),
      owner_subject: 'carol',
      grantee_subject: 'ann',
      expires_at: FAR,
      created_at: at(6),
    },
    {
      id: id(23),
      agent_id: id(1),
      owner_subject: 'ann',
      grantee_subject: 'bob',
      expires_at: PAST,
      created_at: at(7),
    },
    {
      id: id(24),
      agent_id: id(1),
      owner_subject: 'ann',
      grantee_subject: 'carol',
      expires_at: FAR,
      created_at: at(7),
    },
    {
      id: id(25),
      agent_id: id(1),
      owner_subject: 'ann',
      grantee_subject: 'dan',
      expires_at: null,
      created_at: at(4),
    },
  ],
  agent_runs: [
    {
      id: id(31),
      agent_id: id(1),
      owner_subject: 'ann',
      trigger_kind: 'manual',
      created_at: at(10),
    },
    {
      id: id(32),
      agent_id: id(1),
      owner_subject: 'ann',
      trigger_kind: 'manual',
      created_at: at(20),
    },
    {
      id: id(33),
      agent_id: id(4),
      owner_subject: 'bob',
      trigger_kind: 'manual',
      created_at: at(30),
    },
  ],
};

const definition = {
  instructions: 'new',
  tools: ['a', 'b'],
  llmModelId: null,
  enabled: true,
  guardrails: 'be nice',
  canAskQuestions: true,
  autoAcceptActions: false,
};

/** An agent record without its write-time timestamps (defaults are now()). */
function stable(record: AgentRecord | null) {
  return record && { ...record, createdAt: undefined, updatedAt: undefined };
}

const noteScope = { provider: 'note', scope: 'agent' };

function chunk(n: number, refId: string, agentId: string, scope: string | null, content: string) {
  return {
    id: id(n),
    provider: 'note',
    ref_id: refId,
    metadata: JSON.stringify({ agentId, title: `t${n}`, ...(scope ? { scope } : {}) }),
    content,
    embedding: '[1,2,3]',
    keywords: ['k'],
    source_at: at(n),
  };
}

const notes = {
  agents: fixture.agents,
  knowledge_chunks: [
    chunk(41, 'ann@example.test/n1#1', id(1), 'agent', 'world'),
    chunk(42, 'ann@example.test/n1', id(1), 'agent', 'hello '),
    chunk(43, 'ann@example.test/n2', id(1), 'agent', 'other'),
    chunk(44, 'ann@example.test/n3', id(1), null, 'not a member'),
    chunk(45, 'ann@example.test/n4', id(2), 'agent', 'second agent'),
    { ...chunk(46, 'ann@example.test/n5', id(1), 'agent', 'other provider'), provider: 'doc' },
  ],
};

const memories = {
  agents: fixture.agents,
  agent_memories: [
    {
      id: id(51),
      agent_id: id(1),
      kind: 'summary',
      content: 'sum',
      created_at: at(1),
      updated_at: at(9),
    },
    { id: id(52), agent_id: id(1), kind: 'entry', content: 'e2', created_at: at(2) },
    { id: id(53), agent_id: id(1), kind: 'entry', content: 'e3', created_at: at(3) },
    { id: id(54), agent_id: id(1), kind: 'entry', content: 'e4', created_at: at(3) },
    { id: id(55), agent_id: id(2), kind: 'entry', content: 'other', created_at: at(5) },
  ],
};

/** Event triggers for the fan-out read: who listens to what, enabled or not. */
const eventTriggers = {
  agents: [
    { ...agent(51, 'ann', 'Mail filer', 1), enabled: true, llm_model_id: null },
    { ...agent(52, 'ann', 'Paused filer', 1), enabled: false },
    { ...agent(53, 'bob', 'Bob filer', 1), enabled: true },
  ],
  agent_triggers: [
    {
      id: id(63),
      agent_id: id(51),
      kind: 'event',
      event_source: 'microsoft',
      event_type: 'mail.received',
      config: JSON.stringify({ match: { from: 'x' } }),
      last_fired_at: at(7),
      created_at: at(2),
    },
    {
      id: id(61),
      agent_id: id(51),
      kind: 'event',
      event_source: 'microsoft',
      event_type: 'mail.received',
      created_at: at(3),
    },
    {
      id: id(62),
      agent_id: id(51),
      kind: 'event',
      event_source: 'microsoft',
      event_type: 'mail.received',
      enabled: false,
      created_at: at(4),
    },
    {
      id: id(64),
      agent_id: id(51),
      kind: 'schedule',
      event_source: 'microsoft',
      event_type: 'mail.received',
      created_at: at(5),
    },
    {
      id: id(65),
      agent_id: id(52),
      kind: 'event',
      event_source: 'microsoft',
      event_type: 'mail.received',
    },
    {
      id: id(66),
      agent_id: id(53),
      kind: 'event',
      event_source: 'microsoft',
      event_type: 'mail.received',
    },
  ],
};

export const agentScenarios: Scenario<DataStore>[] = [
  {
    method: 'agents.list',
    name: 'newest first, ties by id, with triggers oldest first; own agents only',
    fixture,
    run: async (store) => [
      await store.agents.list('ann'),
      (await store.agents.list('bob')).map((a) => a.triggers),
      await store.agents.list('nobody'),
    ],
  },
  {
    method: 'agents.find',
    name: 'by id, owner-scoped when asked; unknown and malformed ids',
    fixture,
    run: async (store) => [
      await store.agents.find(id(1)),
      await store.agents.find(id(1).toUpperCase(), { ownerSubject: 'ann' }),
      await store.agents.find(id(1), { ownerSubject: 'bob' }),
      await store.agents.find(id(99)),
      await store.agents.find('nope').then(() => 'answered', refusal),
    ],
  },
  {
    method: 'agents.listChainedAfter',
    name: 'the owner’s enabled agent triggers naming the caller, by name',
    fixture: {
      ...fixture,
      agent_triggers: [
        ...[
          [21, 3, id(1), true],
          [22, 2, id(1), true],
          [23, 2, id(1), true],
          [24, 1, id(2), true],
          [25, 3, id(1), false],
          [26, 4, id(1), true],
        ].map(([n, agentN, caller, enabled]) => ({
          id: id(Number(n)),
          agent_id: id(Number(agentN)),
          kind: 'agent',
          enabled: Boolean(enabled),
          config: JSON.stringify({ callerAgentId: caller }),
        })),
        {
          id: id(27),
          agent_id: id(3),
          kind: 'schedule',
          config: JSON.stringify({ every: 'day', at: '08:00', callerAgentId: id(1) }),
          next_run_at: at(100),
        },
      ],
    },
    run: async (store) => [
      await store.agents.listChainedAfter(id(1), 'ann'),
      await store.agents.listChainedAfter(id(2), 'ann'),
      await store.agents.listChainedAfter(id(1), 'bob'),
      await store.agents.listChainedAfter(id(5), 'carol'),
    ],
  },
  {
    method: 'agents.listNames',
    name: 'by name (collation), own only',
    fixture,
    run: async (store) => [
      await store.agents.listNames('ann'),
      await store.agents.listNames('nobody'),
    ],
  },
  {
    method: 'agents.namesLike',
    name: 'prefix match, case-sensitive, wildcards act',
    fixture: {
      agents: [
        agent(1, 'ann', 'Report', 1),
        agent(2, 'ann', 'Report (imported)', 2),
        agent(3, 'bob', 'report', 3),
        agent(4, 'bob', 'Rxport', 4),
      ],
    },
    run: async (store) => [
      await store.agents.namesLike('Report'),
      await store.agents.namesLike('R_port'),
      await store.agents.namesLike('Zed'),
    ],
  },
  {
    method: 'agents.create',
    name: 'creates stale at revision 1; a taken name is NAME_TAKEN',
    fixture,
    run: async (store) => {
      const created = await store.agents.create({
        id: id(9),
        ownerSubject: 'ann',
        name: 'Delta',
        ...definition,
      });
      const taken = await store.agents.create({
        id: id(10),
        ownerSubject: 'bob',
        name: 'Alpha',
        ...definition,
      });
      return {
        created,
        taken,
        row: stable(await store.agents.find(id(9))),
        refused: await store.agents.find(id(10)),
      };
    },
  },
  {
    method: 'agents.update',
    name: 'bumps the revision; stale optional; not-theirs and name clashes',
    fixture,
    run: async (store) => {
      const outcomes = [
        await store.agents.update(
          'ann',
          id(1),
          { ...definition, name: 'Alpha 2' },
          { markDescriptionStale: false }
        ),
        await store.agents.update(
          'ann',
          id(2),
          { ...definition, name: 'beta' },
          {
            markDescriptionStale: true,
          }
        ),
        await store.agents.update(
          'bob',
          id(1),
          { ...definition, name: 'x' },
          {
            markDescriptionStale: true,
          }
        ),
        await store.agents.update(
          'ann',
          id(3),
          { ...definition, name: 'Bob agent' },
          {
            markDescriptionStale: true,
          }
        ),
      ];
      const [one, two, three] = await Promise.all([
        store.agents.find(id(1)),
        store.agents.find(id(2)),
        store.agents.find(id(3)),
      ]);
      return { outcomes, rows: [one, two, three].map((row) => ({ ...stable(row), triggers: [] })) };
    },
  },
  {
    method: 'agents.delete',
    name: 'own agent only; triggers and grants go with it',
    fixture,
    run: async (store) => [
      await store.agents.delete('bob', id(1)),
      await store.agents.delete('ann', id(1)),
      await store.agents.find(id(1)),
      await store.agents.listGrants(id(1)),
      await store.agents.listTriggers(id(1)),
    ],
  },
  {
    method: 'agents.saveDescription',
    name: 'ok stores text and notes; failed only marks it',
    fixture,
    run: async (store) => {
      await store.agents.saveDescription(id(1), {
        status: 'ok',
        description: 'Summarises Jira',
        reviewNotes: [{ issue: 'a', fix: 'b' }],
      });
      await store.agents.saveDescription(id(2), { status: 'failed' });
      const [one, two] = await Promise.all([store.agents.find(id(1)), store.agents.find(id(2))]);
      return [one, two].map(
        (row) => row && [row.description, row.reviewNotes, row.descriptionStatus]
      );
    },
  },
  {
    method: 'agents.markDescriptionStale',
    name: 'marks one agent stale',
    fixture: {
      agents: [
        { ...agent(1, 'ann', 'A', 1), description_status: 'ok' },
        { ...agent(2, 'ann', 'B', 1), description_status: 'ok' },
      ],
    },
    run: async (store) => {
      await store.agents.markDescriptionStale(id(1));
      return (await store.agents.list('ann')).map((row) => [row.id, row.descriptionStatus]);
    },
  },
  {
    method: 'agents.listTriggers',
    name: 'oldest first, ties by id; none for an agent without',
    fixture,
    run: async (store) => [
      await store.agents.listTriggers(id(1)),
      await store.agents.listTriggers(id(2)),
    ],
  },
  {
    method: 'agents.applyTriggerChanges',
    name: 'updates, inserts and deletes; other agents untouched',
    fixture,
    run: async (store) => {
      await store.agents.applyTriggerChanges(id(1), {
        update: [
          {
            id: id(11),
            eventSource: null,
            eventType: null,
            config: JSON.stringify({ every: 'week' }),
            enabled: false,
            nextRunAt: new Date(at(200)),
          },
          // Another agent's trigger is not this agent's to change.
          {
            id: id(14),
            eventSource: 'x',
            eventType: 'y',
            config: '{}',
            enabled: false,
            nextRunAt: null,
          },
        ],
        insert: [
          {
            id: id(15),
            kind: 'api',
            eventSource: null,
            eventType: null,
            config: JSON.stringify({ inputs: [], keyHash: 'h', keyHint: 'abcd' }),
            enabled: true,
            nextRunAt: null,
          },
        ],
        remove: [id(12), id(14)],
      });
      const strip = (list: Awaited<ReturnType<DataStore['agents']['listTriggers']>>) =>
        list.map((t) => ({ ...t, createdAt: t.id === id(15) ? undefined : t.createdAt }));
      return [
        strip(await store.agents.listTriggers(id(1))),
        await store.agents.listTriggers(id(4)),
      ];
    },
  },
  {
    method: 'agents.applyTriggerChanges',
    name: 'a duplicate insert id changes nothing',
    fixture,
    run: async (store) => {
      const outcome = await store.agents
        .applyTriggerChanges(id(1), {
          update: [],
          insert: [
            {
              id: id(13),
              kind: 'api',
              eventSource: null,
              eventType: null,
              config: '{}',
              enabled: true,
              nextRunAt: null,
            },
          ],
          remove: [id(12)],
        })
        .then(() => 'applied', refusal);
      return { outcome, triggers: (await store.agents.listTriggers(id(1))).map((t) => t.id) };
    },
  },
  {
    method: 'agents.findActiveGrant',
    name: 'unexpired grants only; the owner needs none',
    fixture,
    run: async (store) => [
      await store.agents.findActiveGrant(id(4), 'ann'),
      await store.agents.findActiveGrant(id(5), 'ann'),
      await store.agents.findActiveGrant(id(1), 'bob'),
      await store.agents.findActiveGrant(id(1), 'ann'),
    ],
  },
  {
    method: 'agents.upsertGrant',
    name: 'grants, then refreshes the expiry on a second share',
    fixture,
    run: async (store) => {
      await store.agents.upsertGrant({
        id: id(26),
        agentId: id(2),
        ownerSubject: 'ann',
        granteeSubject: 'bob',
        expiresAt: null,
      });
      await store.agents.upsertGrant({
        id: id(27),
        agentId: id(1),
        ownerSubject: 'ann',
        granteeSubject: 'bob',
        expiresAt: new Date(FAR),
      });
      return [await store.agents.listGrants(id(2)), await store.agents.listGrants(id(1))].map(
        (list) =>
          list.map((grant) => ({
            ...grant,
            createdAt: grant.id === id(26) ? undefined : grant.createdAt,
          }))
      );
    },
  },
  {
    method: 'agents.listGrants',
    name: 'oldest first with identities, expired included',
    fixture,
    run: async (store) => [
      await store.agents.listGrants(id(1)),
      await store.agents.listGrants(id(2)),
    ],
  },
  {
    method: 'agents.revokeGrant',
    name: "the owner's grant on this agent only",
    fixture,
    run: async (store) => [
      await store.agents.revokeGrant('bob', id(1), id(23)),
      await store.agents.revokeGrant('ann', id(2), id(23)),
      await store.agents.revokeGrant('ann', id(1), id(23)),
      await store.agents.revokeGrant('ann', id(1), id(23)),
      (await store.agents.listGrants(id(1))).map((grant) => grant.id),
    ],
  },
  {
    method: 'agents.listSharedWith',
    name: 'unexpired, newest first, with the owner identity',
    fixture,
    run: async (store) => [
      await store.agents.listSharedWith('ann'),
      await store.agents.listSharedWith('bob'),
      await store.agents.listSharedWith('carol'),
    ],
  },
  {
    method: 'agents.countActiveGrants',
    name: 'expired grants do not count',
    fixture,
    run: async (store) => [
      await store.agents.countActiveGrants(id(1)),
      await store.agents.countActiveGrants(id(2)),
    ],
  },
  {
    method: 'agents.listForAdmin',
    name: 'every agent or one owner, by name, with email and last run',
    fixture,
    run: async (store) => [
      await store.agents.listForAdmin({ ownerSubject: null }),
      await store.agents.listForAdmin({ ownerSubject: 'bob' }),
      await store.agents.listForAdmin({ ownerSubject: 'nobody' }),
    ],
  },
  {
    method: 'agents.findForAdmin',
    name: 'one agent, any owner; unknown is null',
    fixture,
    run: async (store) => [
      await store.agents.findForAdmin(id(1)),
      await store.agents.findForAdmin(id(5)),
      await store.agents.findForAdmin(id(99)),
    ],
  },
  {
    method: 'agents.listNoteChunks',
    name: 'members of this agent with this provider, by ref',
    fixture: notes,
    run: async (store) => [
      await store.agents.listNoteChunks(id(1), noteScope),
      await store.agents.listNoteChunks(id(3), noteScope),
    ],
  },
  {
    method: 'agents.noteExists',
    name: 'by base ref or chunk; other agents and non-members are not found',
    fixture: notes,
    run: async (store) => [
      await store.agents.noteExists(id(1), 'ann@example.test/n1', noteScope),
      await store.agents.noteExists(id(1), 'ann@example.test/n2', noteScope),
      await store.agents.noteExists(id(1), 'ann@example.test/n3', noteScope),
      await store.agents.noteExists(id(1), 'ann@example.test/n4', noteScope),
      await store.agents.noteExists(id(1), 'ann@example.test/n', noteScope),
    ],
  },
  {
    method: 'agents.copyNoteChunks',
    name: 'every chunk under the new base, stamped with the target',
    fixture: notes,
    run: async (store) => {
      const copied = await store.agents.copyNoteChunks({
        provider: 'note',
        baseRef: 'ann@example.test/n1',
        newBase: 'bob@example.test/m1',
        targetAgentId: id(2),
      });
      return { copied, target: await store.agents.listNoteChunks(id(2), noteScope) };
    },
  },
  {
    method: 'agents.memorySlice',
    name: 'newest entries first, the summary found inside or outside the window',
    fixture: memories,
    run: async (store) => [
      await store.agents.memorySlice(id(1), 10),
      await store.agents.memorySlice(id(1), 1),
      await store.agents.memorySlice(id(3), 10),
      await store.agents.memorySlice(id(99), 10),
    ],
  },
  {
    method: 'agents.clearMemory',
    name: "this agent's rows only",
    fixture: memories,
    run: async (store) => [
      await store.agents.clearMemory(id(1)),
      await store.agents.memorySlice(id(1), 10),
      (await store.agents.memorySlice(id(2), 10)).entries.length,
    ],
  },
  {
    method: 'agents.setEnabled',
    name: "any owner's agent, by id; a missing one is null; a read after shows it",
    fixture,
    run: async (store) => {
      const results = [
        await store.agents.setEnabled(id(4), false),
        await store.agents.setEnabled(id(2), true),
        await store.agents.setEnabled(id(99), true),
      ];
      const after = await Promise.all(
        [id(4), id(2), id(1)].map(async (agentId) => {
          const found = await store.agents.find(agentId);
          return found ? { id: found.id, enabled: found.enabled } : null;
        })
      );
      const malformed = await store.agents.setEnabled('not-a-uuid', true).then(
        () => 'accepted',
        (error: unknown) => refusal(error)
      );
      return { results, after, malformed };
    },
  },
  {
    method: 'agents.markTriggerFired',
    name: 'stamps the one trigger and clears its error; others untouched',
    fixture,
    run: async (store) => {
      await store.agents.markTriggerFired(id(12));
      await store.agents.markTriggerFired(id(98));
      return (await store.agents.listTriggers(id(1))).map((trigger) => ({
        id: trigger.id,
        fired: trigger.lastFiredAt !== null,
        lastError: trigger.lastError,
      }));
    },
  },
  {
    method: 'agents.addMemoryEntry',
    name: 'a new entry reads back newest; a duplicate id is refused',
    fixture: memories,
    run: async (store) => {
      await store.agents.addMemoryEntry({
        id: id(56),
        agentId: id(1),
        content: 'sealed-new',
        runId: null,
      });
      const again = await store.agents
        .addMemoryEntry({ id: id(56), agentId: id(1), content: 'x', runId: null })
        .then(
          () => 'accepted',
          (error: unknown) => refusal(error)
        );
      const slice = await store.agents.memorySlice(id(1), 10);
      return { again, ids: slice.entries.map((e) => [e.id, e.content]) };
    },
  },
  {
    method: 'agents.saveMemorySummary',
    name: 'replaces the one summary in place, or creates it',
    fixture: memories,
    run: async (store) => {
      await store.agents.saveMemorySummary({ id: id(57), agentId: id(1), content: 'sum-2' });
      await store.agents.saveMemorySummary({ id: id(58), agentId: id(2), content: 'first' });
      const one = await store.agents.memorySlice(id(1), 10);
      const two = await store.agents.memorySlice(id(2), 10);
      return {
        one: one.summary?.content,
        two: two.summary?.content,
        counts: [await store.agents.countMemory(id(1)), await store.agents.countMemory(id(2))],
      };
    },
  },
  {
    method: 'agents.countMemory',
    name: 'entries and the summary, per agent',
    fixture: memories,
    run: async (store) => [
      await store.agents.countMemory(id(1)),
      await store.agents.countMemory(id(2)),
      await store.agents.countMemory(id(99)),
    ],
  },
  {
    method: 'agents.deleteMemorySummary',
    name: 'the summary only; entries stay',
    fixture: memories,
    run: async (store) => [
      await store.agents.deleteMemorySummary(id(1)),
      await store.agents.deleteMemorySummary(id(1)),
      await store.agents.countMemory(id(1)),
    ],
  },
  {
    method: 'agents.deleteMemoryEntries',
    name: "this agent's entries only; the summary and other agents' ids stay",
    fixture: memories,
    run: async (store) => [
      await store.agents.deleteMemoryEntries(id(1), [id(54), id(52), id(55), id(51), id(98)]),
      await store.agents.deleteMemoryEntries(id(1), []),
      await store.agents.countMemory(id(1)),
      await store.agents.countMemory(id(2)),
    ],
  },
  {
    method: 'agents.recentNoteChunks',
    name: 'newest dated first, bounded, members only',
    fixture: {
      ...notes,
      knowledge_chunks: [
        ...notes.knowledge_chunks,
        { ...chunk(47, 'ann@example.test/n6', id(1), 'agent', 'undated'), source_at: null },
      ],
    },
    run: async (store) => [
      (await store.agents.recentNoteChunks(id(1), { ...noteScope, limit: 10 })).map((c) => c.refId),
      (await store.agents.recentNoteChunks(id(1), { ...noteScope, limit: 2 })).map((c) => c.refId),
      await store.agents.recentNoteChunks(id(3), { ...noteScope, limit: 10 }),
    ],
  },
  {
    method: 'agents.findRunSettings',
    name: 'the switches as stored, defaults included; a missing agent is null',
    fixture: {
      agents: [
        {
          ...agent(1, 'ann', 'Alpha', 1),
          guardrails: 'never email',
          can_ask_questions: true,
          auto_accept_actions: true,
        },
        agent(2, 'bob', 'Beta', 2),
      ],
    },
    run: async (store) => [
      await store.agents.findRunSettings(id(1)),
      await store.agents.findRunSettings(id(2)),
      await store.agents.findRunSettings(id(99)),
    ],
  },
  {
    method: 'agents.listChainTargets',
    name: 'enabled agent triggers naming the caller, on enabled agents of any owner, by trigger id',
    fixture: {
      agents: [
        agent(1, 'ann', 'Caller', 1),
        { ...agent(2, 'bob', 'Bob chained', 2), enabled: true, llm_model_id: null },
        agent(3, 'carol', 'Carol chained', 3),
        { ...agent(4, 'dan', 'Disabled agent', 4), enabled: false },
      ],
      agent_triggers: [
        {
          id: id(14),
          agent_id: id(3),
          kind: 'agent',
          config: JSON.stringify({ callerAgentId: id(1) }),
        },
        {
          id: id(12),
          agent_id: id(2),
          kind: 'agent',
          config: JSON.stringify({ callerAgentId: id(1) }),
        },
        {
          id: id(13),
          agent_id: id(2),
          kind: 'agent',
          enabled: false,
          config: JSON.stringify({ callerAgentId: id(1) }),
        },
        {
          id: id(15),
          agent_id: id(4),
          kind: 'agent',
          config: JSON.stringify({ callerAgentId: id(1) }),
        },
        {
          id: id(16),
          agent_id: id(3),
          kind: 'agent',
          config: JSON.stringify({ callerAgentId: id(2) }),
        },
        {
          id: id(17),
          agent_id: id(3),
          kind: 'event',
          config: JSON.stringify({ callerAgentId: id(1) }),
        },
      ],
    },
    run: async (store) => [
      await store.agents.listChainTargets(id(1)),
      await store.agents.listChainTargets(id(3)),
    ],
  },
  {
    method: 'agents.markTriggerFailed',
    name: 'the last error is set; when it last fired stays; other triggers untouched',
    fixture: {
      agents: [agent(1, 'ann', 'Alpha', 1)],
      agent_triggers: [
        { id: id(11), agent_id: id(1), kind: 'agent', config: '{}', last_fired_at: at(5) },
        { id: id(12), agent_id: id(1), kind: 'agent', config: '{}', created_at: at(6) },
      ],
    },
    run: async (store) => {
      await store.agents.markTriggerFailed(id(11), 'chain refused');
      await store.agents.markTriggerFailed(id(99), 'nobody');
      const triggers = await store.agents.listTriggers(id(1));
      return triggers.map((t) => ({
        id: t.id,
        lastError: t.lastError,
        lastFiredAt: t.lastFiredAt,
      }));
    },
  },
  {
    method: 'agents.listEventTriggers',
    name: "enabled event triggers of the owner's enabled agents for this source/type, by id",
    fixture: eventTriggers,
    run: async (store) => [
      await store.agents.listEventTriggers({
        source: 'microsoft',
        type: 'mail.received',
        ownerSubject: 'ann',
      }),
      await store.agents.listEventTriggers({
        source: 'microsoft',
        type: 'mail.received',
        ownerSubject: 'bob',
      }),
      await store.agents.listEventTriggers({
        source: 'microsoft',
        type: 'mail.sent',
        ownerSubject: 'ann',
      }),
    ],
  },
];
