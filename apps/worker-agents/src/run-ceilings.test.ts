/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The run guards beside the org's daily cap, on the memory store: one
 * owner and one event/API trigger have ceilings of their own, so neither
 * can use up the day for everyone else.
 */

let orgCap = 200;
jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({
    ok: true,
    val: { agentMaxChainDepth: 3, agentMaxRunsPerDay: orgCap },
  }),
}));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { ok } from '@campfhir/safe-functions/helpers';
import type { AgentDefinition } from '@renkei/agents';
import {
  createAgentRun,
  ownerDailyRunCap,
  triggerDailyRunCap,
  type CreateAgentRunInput,
} from '@renkei/agents/runs';

const producer = { enqueue: async () => ok({}) } as unknown as QueueProducer;
const definition = { instructions: 'do', tools: [] } as unknown as AgentDefinition;
const AGENT = '00000000-0000-4000-8000-000000000001';

function input(overrides: Partial<CreateAgentRunInput>): CreateAgentRunInput {
  return {
    agentId: AGENT,
    ownerSubject: 'ann',
    definition,
    llmModelId: null,
    triggerId: null,
    triggerKind: 'manual',
    ...overrides,
  };
}

describe('per-owner and per-trigger run ceilings', () => {
  beforeEach(() => {
    registerDataStore(createMemoryDataStore());
    orgCap = 200;
  });
  afterEach(() => resetDataStore());

  it('scales with the org cap and never falls below a usable floor', () => {
    expect(ownerDailyRunCap(200)).toBe(100);
    expect(ownerDailyRunCap(10)).toBe(20);
    expect(triggerDailyRunCap(200)).toBe(50);
    expect(triggerDailyRunCap(10)).toBe(10);
  });

  it('stops one owner at their share while another owner still runs', async () => {
    orgCap = 40; // owner ceiling 20
    for (let i = 0; i < 20; i++) {
      expect((await createAgentRun(producer, input({}))).ok).toBe(true);
    }
    const refused = await createAgentRun(producer, input({}));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.err.type).toBe('DAILY_RUN_CAP');
    expect((await createAgentRun(producer, input({ ownerSubject: 'bob' }))).ok).toBe(true);
    expect(await getDataStore().agentRuns.countCreatedSince(new Date(0))).toBe(21);
  });

  it('stops an event trigger at its share, but not a schedule or a manual run', async () => {
    orgCap = 40; // trigger ceiling 10, owner ceiling 20
    const trigger = '00000000-0000-4000-8000-0000000000aa';
    await getDataStore().agentRuns.createQueued({
      id: '00000000-0000-4000-8000-0000000000b0',
      agentId: AGENT,
      ownerSubject: 'bob',
      triggerId: trigger,
      triggerKind: 'api',
      triggeredBySubject: null,
      parentRunId: null,
      lineage: [],
      definitionSnapshot: definition,
      llmModelId: null,
      initialState: null,
    });
    for (let i = 0; i < 9; i++) {
      const made = await createAgentRun(
        producer,
        input({ ownerSubject: `o${i}`, triggerId: trigger, triggerKind: 'api' })
      );
      expect(made.ok).toBe(true);
    }
    const refused = await createAgentRun(
      producer,
      input({ ownerSubject: 'fresh', triggerId: trigger, triggerKind: 'event' })
    );
    expect(refused.ok).toBe(false);
    expect(
      (
        await createAgentRun(
          producer,
          input({ ownerSubject: 'fresh', triggerId: trigger, triggerKind: 'schedule' })
        )
      ).ok
    ).toBe(true);
    expect((await createAgentRun(producer, input({ ownerSubject: 'fresh' }))).ok).toBe(true);
  });
});
