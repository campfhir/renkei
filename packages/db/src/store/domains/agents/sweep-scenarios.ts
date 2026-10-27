import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-ab${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const iso = (minute: number) => at(minute).toISOString();

const MODEL = id(90);

const agents = [
  { id: id(1), owner_subject: 'ann', name: 'A', llm_model_id: MODEL },
  { id: id(2), owner_subject: 'bob', name: 'B' },
  { id: id(3), owner_subject: 'ann', name: 'C' },
  { id: id(4), owner_subject: 'cat', name: 'D', enabled: false },
];

function memory(n: number, agent: number, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(100 + n),
    agent_id: id(agent),
    kind: 'entry',
    content: `note ${n}`,
    created_at: iso(minute),
    updated_at: iso(minute),
    ...extra,
  };
}

const memoryFixture = {
  llm_model_configs: [
    {
      id: MODEL,
      label: 'Model',
      provider: 'anthropic',
      model: 'big',
      encrypted_secrets: 'sealed',
    },
  ],
  agents,
  agent_memories: [
    // Agent 1: five entries (two tied at minute 3) and a summary.
    memory(1, 1, 1),
    memory(2, 1, 2),
    memory(3, 1, 3),
    memory(4, 1, 3),
    memory(5, 1, 5, { content: 'uenc1:sealed' }),
    memory(6, 1, 9, { kind: 'summary', content: 'the summary' }),
    // Agent 2: five entries, no summary.
    memory(11, 2, 1),
    memory(12, 2, 2),
    memory(13, 2, 3),
    memory(14, 2, 4),
    memory(15, 2, 5, { content: 'uenc1:also sealed' }),
    // Agent 3: two entries.
    memory(21, 3, 1),
    memory(22, 3, 2),
  ],
};

function trigger(n: number, agent: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(200 + n),
    agent_id: id(agent),
    kind: 'schedule',
    config: JSON.stringify({ recurrences: [{ every: 'day' }], timezone: 'UTC' }),
    enabled: true,
    created_at: iso(1),
    updated_at: iso(1),
    ...extra,
  };
}

const triggerFixture = {
  agents: [
    { ...agents[0], llm_model_id: null, instructions: 'do it', tools: JSON.stringify(['x']) },
    ...agents.slice(1),
  ],
  agent_triggers: [
    trigger(1, 1, { next_run_at: iso(10) }),
    trigger(2, 2, { next_run_at: iso(5) }),
    trigger(3, 1, { next_run_at: iso(10) }),
    trigger(4, 1, { next_run_at: iso(30) }),
    trigger(5, 1, { next_run_at: null }),
    trigger(6, 1, { next_run_at: iso(1), enabled: false }),
    trigger(7, 4, { next_run_at: iso(1) }),
    trigger(8, 3, { next_run_at: iso(2), kind: 'event' }),
  ],
};

const triggerState = async (store: DataStore, agentId: string) =>
  (await store.agents.listTriggers(agentId)).map((t) => ({
    id: t.id,
    enabled: t.enabled,
    nextRunAt: t.nextRunAt,
    fired: t.lastFiredAt !== null,
    lastError: t.lastError,
  }));

export const agentSweepScenarios: Scenario<DataStore>[] = [
  {
    method: 'agents.memoryCompactionCandidates',
    name: 'over the threshold, most entries first, ties by agent id, bounded',
    fixture: memoryFixture,
    run: async (store) => [
      await store.agents.memoryCompactionCandidates(2, 10),
      await store.agents.memoryCompactionCandidates(1, 1),
      await store.agents.memoryCompactionCandidates(5, 10),
    ],
  },
  {
    method: 'agents.memoryFoldSet',
    name: 'past the keep window, newest first with id ties, summary and model; null when nothing',
    fixture: memoryFixture,
    run: async (store) => [
      await store.agents.memoryFoldSet(id(1), { keepRecent: 1, limit: 3 }),
      await store.agents.memoryFoldSet(id(2), { keepRecent: 2, limit: 10 }),
      await store.agents.memoryFoldSet(id(3), { keepRecent: 2, limit: 10 }),
      await store.agents.memoryFoldSet(id(9), { keepRecent: 0, limit: 10 }),
    ],
  },
  {
    method: 'agents.trimMemoryEntries',
    name: 'entries past the newest `keep` go; the summary and other agents stay',
    fixture: memoryFixture,
    run: async (store) => [
      await store.agents.trimMemoryEntries(id(1), 2),
      await store.agents.trimMemoryEntries(id(1), 2),
      await store.agents.trimMemoryEntries(id(3), 5),
      await store.agents.countMemory(id(1)),
      (await store.agents.memorySlice(id(1), 10)).entries.map((e) => e.id),
      await store.agents.countMemory(id(2)),
    ],
  },
  {
    method: 'agents.listPlaintextMemory',
    name: 'unsealed rows of every agent by id, paged after an id',
    fixture: memoryFixture,
    run: async (store) => {
      const first = await store.agents.listPlaintextMemory({
        afterId: null,
        sealedPrefix: 'uenc1:',
        limit: 4,
      });
      const next = await store.agents.listPlaintextMemory({
        afterId: first[first.length - 1].id,
        sealedPrefix: 'uenc1:',
        limit: 50,
      });
      const none = await store.agents.listPlaintextMemory({
        afterId: id(999),
        sealedPrefix: 'uenc1:',
        limit: 50,
      });
      return [first, next, none];
    },
  },
  {
    method: 'agents.replaceMemoryContent',
    name: 'only while the content is still as read',
    fixture: memoryFixture,
    run: async (store) => [
      await store.agents.replaceMemoryContent(id(101), 'note 1', 'uenc1:new'),
      await store.agents.replaceMemoryContent(id(102), 'changed meanwhile', 'uenc1:new'),
      await store.agents.replaceMemoryContent(id(999), 'note 1', 'uenc1:new'),
      (await store.agents.memorySlice(id(1), 10)).entries.map((e) => [e.id, e.content]),
    ],
  },
  {
    method: 'agents.listDueScheduleTriggers',
    name: 'enabled schedules of enabled agents due by now, soonest first with id ties',
    fixture: triggerFixture,
    run: async (store) => [
      await store.agents.listDueScheduleTriggers(at(10), 10),
      await store.agents.listDueScheduleTriggers(at(10), 2),
      await store.agents.listDueScheduleTriggers(at(0), 10),
    ],
  },
  {
    method: 'agents.disableTrigger',
    name: 'off with the reason; other triggers untouched',
    fixture: triggerFixture,
    run: async (store) => {
      await store.agents.disableTrigger(id(201), 'malformed');
      return [await triggerState(store, id(1)), await triggerState(store, id(2))];
    },
  },
  {
    method: 'agents.advanceScheduleTrigger',
    name: 'one winner per observed time; a stale observation loses',
    fixture: triggerFixture,
    run: async (store) => {
      const won = await store.agents.advanceScheduleTrigger(id(201), at(10), at(100));
      const lost = await store.agents.advanceScheduleTrigger(id(201), at(10), at(200));
      const unset = await store.agents.advanceScheduleTrigger(id(205), at(10), at(100));
      return [won, lost, unset, await triggerState(store, id(1))];
    },
  },
  {
    method: 'agents.setTriggerError',
    name: 'recorded, then cleared',
    fixture: triggerFixture,
    run: async (store) => {
      await store.agents.setTriggerError(id(202), 'could not start');
      const set = await triggerState(store, id(2));
      await store.agents.setTriggerError(id(202), null);
      return [set, await triggerState(store, id(2))];
    },
  },
];
