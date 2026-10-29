/**
 * Chaining and the failure event, against a real database (skipped without
 * DATABASE_URL). What must hold: success starts every authorized chained
 * agent with the parent in its lineage; a cycle refuses with the reason on
 * the target trigger; failure emits exactly one run.failed event and no
 * chain.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { InMemoryQueue } from '@renkei/queue';
import type { AgentDefinition } from '@renkei/agents';
import { createFinalizeHook } from './finalize';
import type { FinalizedRun } from './engine';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('finalize hook', () => {
  jest.setTimeout(20_000);

  // Every suite run seeds under its own owner and ids, so nothing needs
  // deleting afterwards and a shared database never collides.
  const suiteId = randomUUID();
  const owner = `chain-owner-${suiteId.slice(0, 8)}`;

  const definition: AgentDefinition = { instructions: '## Goal\n\nReact to the email.', tools: [] };

  afterAll(async () => {
    await closeDataStore();
  });

  async function seedAgent(name: string): Promise<string> {
    const agentId = randomUUID();
    await getDataStore().agents.create({
      id: agentId,
      ownerSubject: owner,
      name: `${name}-${agentId.slice(0, 8)}`,
      instructions: definition.instructions,
      tools: definition.tools,
      llmModelId: null,
      enabled: true,
      guardrails: null,
      canAskQuestions: false,
      autoAcceptActions: false,
    });
    return agentId;
  }

  async function addTrigger(
    agentId: string,
    trigger: { kind: string; eventSource?: string; eventType?: string; config: unknown }
  ): Promise<string> {
    const triggerId = randomUUID();
    await getDataStore().agents.applyTriggerChanges(agentId, {
      update: [],
      insert: [
        {
          id: triggerId,
          kind: trigger.kind,
          eventSource: trigger.eventSource ?? null,
          eventType: trigger.eventType ?? null,
          config: JSON.stringify(trigger.config),
          enabled: true,
          nextRunAt: null,
        },
      ],
      remove: [],
    });
    return triggerId;
  }

  const chainTrigger = (targetAgentId: string, callerAgentId: string): Promise<string> =>
    addTrigger(targetAgentId, { kind: 'agent', config: { callerAgentId } });

  /** A run created queued, then ended by its executor as succeeded. */
  async function seedFinishedRun(run: {
    agentId: string;
    lineage: string[];
    triggerId?: string;
    triggerKind: string;
    initialState?: Record<string, unknown>;
  }): Promise<string> {
    const runs = getDataStore().agentRuns;
    const runId = randomUUID();
    await runs.createQueued({
      id: runId,
      agentId: run.agentId,
      ownerSubject: owner,
      triggerId: run.triggerId ?? null,
      triggerKind: run.triggerKind,
      triggeredBySubject: null,
      parentRunId: null,
      lineage: run.lineage,
      definitionSnapshot: definition,
      llmModelId: null,
      initialState: run.initialState ?? null,
    });
    await runs.finishExecution(runId, { status: 'succeeded', errorKind: null, error: null });
    return runId;
  }

  const seedRun = (agentId: string, lineage: string[]): Promise<string> =>
    seedFinishedRun({ agentId, lineage, triggerKind: 'manual' });

  /** A run started by a WebEx event trigger, thread coordinates in state. */
  async function seedWebexRun(agentId: string): Promise<string> {
    const triggerId = await addTrigger(agentId, {
      kind: 'event',
      eventSource: 'webex',
      eventType: 'message.received',
      config: { match: {} },
    });
    return seedFinishedRun({
      agentId,
      lineage: [],
      triggerId,
      triggerKind: 'event',
      initialState: { roomId: 'room-1', messageId: 'msg-1', text: 'hello' },
    });
  }

  const runsOf = (agentId: string) =>
    getDataStore().agentRuns.list({ agentId, ownerSubject: owner, audience: 'owner', limit: 100 });

  const finalized = (
    runId: string,
    agentId: string,
    status: 'succeeded' | 'failed'
  ): FinalizedRun => ({
    runId,
    agentId,
    ownerSubject: owner,
    status,
    quiet: false,
    errorKind: status === 'failed' ? 'step_failed' : null,
    error: status === 'failed' ? 'Step "Do the thing" stopped the agent.' : null,
    vars: { summary: 'Filed it.', result: 'PROJ-42' },
  });

  it('starts the chained agent with the parent in its lineage', async () => {
    const a = await seedAgent('agent-a');
    const b = await seedAgent('agent-b');
    await chainTrigger(b, a);
    const parentRunId = await seedRun(a, []);

    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      agentQueue.producer,
      eventsQueue.producer
    )(finalized(parentRunId, a, 'succeeded'));

    const childRuns = await runsOf(b);
    expect(childRuns).toHaveLength(1);
    const childId = childRuns[0].id;
    const link = await getDataStore().agentRuns.findChainLink(childId);
    expect(link?.parentRunId).toBe(parentRunId);
    // The depth is the lineage's length; the store derives one from the other.
    expect(link?.lineage).toEqual([a]);
    expect(link?.triggerKind).toBe('agent');
    const child = await getDataStore().agentRuns.findForExecution(childId);
    const initialState = child?.initialState;
    const state: { parentSummary?: unknown } =
      typeof initialState === 'object' && initialState !== null && !Array.isArray(initialState)
        ? initialState
        : {};
    expect(String(state.parentSummary)).toContain('PROJ-42');
  });

  it('refuses a cycle and says so on the target trigger', async () => {
    const a = await seedAgent('cycle-a');
    const b = await seedAgent('cycle-b');
    const backTrigger = await chainTrigger(a, b); // A runs after B — the back edge
    // B's run was itself chained from A.
    const bRunId = await seedRun(b, [a]);

    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      agentQueue.producer,
      eventsQueue.producer
    )(finalized(bRunId, b, 'succeeded'));

    expect(await runsOf(a)).toHaveLength(0);

    const trigger = (await getDataStore().agents.listTriggers(a)).find(
      (row) => row.id === backTrigger
    );
    expect(trigger?.lastError).toContain('already ran');
  });

  it('never posts an automatic thread reply — answering the room is a STEP', async () => {
    const agentId = await seedAgent('no-auto-reply');
    const runId = await seedWebexRun(agentId);
    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      agentQueue.producer,
      eventsQueue.producer
    )({
      ...finalized(runId, agentId, 'succeeded'),
      vars: { result: 'a saved result must not leak into the room' },
    });
    expect(await eventsQueue.consumer.claim()).toBeNull();
  });

  it('a failed webex-triggered run emits only the owner notification', async () => {
    const agentId = await seedAgent('failnotify-a');
    const runId = await seedWebexRun(agentId);
    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      agentQueue.producer,
      eventsQueue.producer
    )(finalized(runId, agentId, 'failed'));

    const first = await eventsQueue.consumer.claim();
    expect(first?.type).toBe('run.failed');
    expect(await eventsQueue.consumer.claim()).toBeNull();
  });

  it('emits run.failed (and no chain) when the run failed', async () => {
    const a = await seedAgent('fail-a');
    const b = await seedAgent('fail-b');
    await chainTrigger(b, a);
    const runId = await seedRun(a, []);

    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      agentQueue.producer,
      eventsQueue.producer
    )(finalized(runId, a, 'failed'));

    const event = await eventsQueue.consumer.claim();
    expect(event?.source).toBe('agents');
    expect(event?.type).toBe('run.failed');
    expect(await runsOf(b)).toHaveLength(0);
  });
});
