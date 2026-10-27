import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-f${String(n).padStart(11, '0')}`;
const OLD = (minute: number) => new Date(Date.UTC(2020, 0, 1, 0, minute));
const RECENT = new Date(Date.UTC(2099, 0, 1));
const refusal = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : 'threw';

const fixture = {
  agents: [{ id: id(1), owner_subject: 'ann', name: 'Alpha', instructions: 'do' }],
  agent_triggers: [
    { id: id(11), agent_id: id(1), kind: 'event', event_source: 'jira', event_type: 'x' },
    { id: id(12), agent_id: id(1), kind: 'event', event_source: 'jira', event_type: 'y' },
  ],
  agent_trigger_firings: [
    { trigger_id: id(11), dedupe_key: 'msg:old-b', run_id: null, created_at: OLD(1) },
    { trigger_id: id(11), dedupe_key: 'msg:old-a', run_id: id(91), created_at: OLD(1) },
    { trigger_id: id(12), dedupe_key: 'msg:old-c', run_id: null, created_at: OLD(2) },
    { trigger_id: id(12), dedupe_key: 'msg:new', run_id: null, created_at: RECENT },
  ],
};

const keys = async (store: DataStore) => {
  const out: string[] = [];
  for (const [trigger, key] of [
    [id(11), 'msg:old-a'],
    [id(11), 'msg:old-b'],
    [id(12), 'msg:old-c'],
    [id(12), 'msg:new'],
  ] as const) {
    if (await store.agentTriggerFirings.find(trigger, key)) out.push(`${trigger}/${key}`);
  }
  return out;
};

export const agentTriggerFiringScenarios: Scenario<DataStore>[] = [
  {
    method: 'agentTriggerFirings.claim',
    name: 'first claim wins, a repeat loses, another key or trigger wins; bad ids refused',
    fixture,
    run: async (store) => [
      await store.agentTriggerFirings.claim(id(11), 'msg:fresh'),
      await store.agentTriggerFirings.claim(id(11), 'msg:fresh'),
      await store.agentTriggerFirings.claim(id(12), 'msg:fresh'),
      await store.agentTriggerFirings.claim(id(11), 'msg:old-a'),
      await store.agentTriggerFirings.find(id(11), 'msg:fresh').then((r) => r && r.runId),
      await store.agentTriggerFirings.claim(id(99), 'msg:fresh').catch(refusal),
      await store.agentTriggerFirings.claim('nope', 'msg:fresh').catch(refusal),
    ],
  },
  {
    method: 'agentTriggerFirings.setRun',
    name: 'the one firing gets its run; others untouched',
    fixture,
    run: async (store) => {
      await store.agentTriggerFirings.setRun(id(11), 'msg:old-b', id(92));
      await store.agentTriggerFirings.setRun(id(12), 'msg:missing', id(93));
      return [
        await store.agentTriggerFirings.find(id(11), 'msg:old-b'),
        await store.agentTriggerFirings.find(id(11), 'msg:old-a'),
        await store.agentTriggerFirings.find(id(12), 'msg:missing'),
      ];
    },
  },
  {
    method: 'agentTriggerFirings.release',
    name: 'the claim goes and can be taken again; others stay',
    fixture,
    run: async (store) => {
      await store.agentTriggerFirings.release(id(11), 'msg:old-a');
      await store.agentTriggerFirings.release(id(12), 'msg:missing');
      const remaining = await keys(store);
      const again = await store.agentTriggerFirings.claim(id(11), 'msg:old-a');
      return { remaining, again };
    },
  },
  {
    method: 'agentTriggerFirings.find',
    name: 'by trigger and key; a missing pair is null',
    fixture,
    run: async (store) => [
      await store.agentTriggerFirings.find(id(11), 'msg:old-a'),
      await store.agentTriggerFirings.find(id(12), 'msg:new'),
      await store.agentTriggerFirings.find(id(12), 'msg:old-a'),
    ],
  },
  {
    method: 'agentTriggerFirings.pruneOlderThan',
    name: 'oldest first up to the limit, ties by trigger then key; recent rows stay',
    fixture,
    run: async (store) => {
      const first = await store.agentTriggerFirings.pruneOlderThan(7, 1);
      const afterFirst = await keys(store);
      const rest = await store.agentTriggerFirings.pruneOlderThan(7, 100);
      const none = await store.agentTriggerFirings.pruneOlderThan(7, 100);
      return { first, afterFirst, rest, none, afterAll: await keys(store) };
    },
  },
];
