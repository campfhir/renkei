/**
 * The sign-in re-queue against a real database (skipped without
 * DATABASE_URL): only THIS owner's runs parked for their key go back to
 * the queue, one message each; a run waiting on an approval, another
 * owner's parked run and a finished run are left alone.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { ok } from '@campfhir/safe-functions/helpers';
import type { QueueMessageInput, QueueProducer } from '@renkei/queue';
import { NEEDS_SIGN_IN, resumeRunsNeedingSignIn } from './needs-sign-in';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('resumeRunsNeedingSignIn', () => {
  const suiteId = randomUUID();
  const owner = `owner-${suiteId.slice(0, 8)}`;
  const other = `other-${suiteId.slice(0, 8)}`;
  const agentId = randomUUID();
  const definition = { instructions: '## Goal\n\nGo.', tools: [] };

  /**
   * A run brought to `status` the engine's way: queued, then parked
   * ('waiting', with `errorKind` when it waits for the owner's key) or
   * started and finished.
   */
  const seedRun = async (
    ownerSubject: string,
    status: string,
    errorKind: string | null
  ): Promise<string> => {
    const runs = getDataStore().agentRuns;
    const id = randomUUID();
    await runs.createQueued({
      id,
      agentId,
      ownerSubject,
      triggerId: null,
      triggerKind: 'manual',
      triggeredBySubject: ownerSubject,
      parentRunId: null,
      lineage: [],
      definitionSnapshot: definition,
      llmModelId: null,
      initialState: {},
    });
    if (status === 'waiting') {
      await runs.updateExecution(id, {
        status: 'waiting',
        waitingUntil: null,
        errorKind,
        error: errorKind ? 'Paused: sign in.' : null,
      });
    } else {
      await runs.updateExecution(id, { status: 'running', startedAt: new Date() });
      await runs.finishExecution(id, { status, errorKind: null, error: null });
    }
    return id;
  };

  const stateOf = async (runId: string) => {
    const runs = getDataStore().agentRuns;
    const run = await runs.findForExecution(runId);
    const failure = await runs.findRunError(runId);
    return { status: run?.status, errorKind: run?.errorKind, error: failure?.error };
  };

  beforeAll(async () => {
    await getDataStore().agents.create({
      id: agentId,
      ownerSubject: owner,
      name: 'Parked agent',
      instructions: definition.instructions,
      tools: definition.tools,
      llmModelId: null,
      enabled: true,
      guardrails: null,
      canAskQuestions: false,
      autoAcceptActions: false,
    });
  });

  afterAll(async () => {
    // The agent's runs (the other owner's included) cascade with it.
    await getDataStore().agents.delete(owner, agentId);
    await closeDataStore();
  });

  it("re-queues only the owner's runs parked for sign-in and enqueues one message each", async () => {
    const parkedA = await seedRun(owner, 'waiting', NEEDS_SIGN_IN);
    const parkedB = await seedRun(owner, 'waiting', NEEDS_SIGN_IN);
    const approval = await seedRun(owner, 'waiting', null);
    const theirs = await seedRun(other, 'waiting', NEEDS_SIGN_IN);
    const done = await seedRun(owner, 'succeeded', null);

    const sent: QueueMessageInput[] = [];
    const producer: QueueProducer = {
      enqueue: async (message) => {
        sent.push(message);
        return ok(undefined);
      },
    };

    expect(await resumeRunsNeedingSignIn(producer, owner)).toBe(2);
    // By run id: the two runs re-queue in no particular order.
    const runIdOf = (payload: unknown) =>
      typeof payload === 'object' && payload !== null && 'runId' in payload
        ? String(payload.runId)
        : '';
    expect(sent.map((m) => runIdOf(m.payload)).sort()).toEqual([parkedA, parkedB].sort());
    expect(new Set(sent.map((m) => m.orderingKey))).toEqual(new Set([`agent:${agentId}`]));
    expect(new Set(sent.map((m) => m.type))).toEqual(new Set(['run']));

    const cleared = { status: 'queued', errorKind: null, error: null };
    expect(await stateOf(parkedA)).toEqual(cleared);
    expect(await stateOf(parkedB)).toEqual(cleared);
    expect((await stateOf(approval)).status).toBe('waiting');
    expect(await stateOf(theirs)).toMatchObject({ status: 'waiting', errorKind: NEEDS_SIGN_IN });
    expect((await stateOf(done)).status).toBe('succeeded');

    // Nothing left to re-queue the second time around.
    expect(await resumeRunsNeedingSignIn(producer, owner)).toBe(0);
    expect(sent).toHaveLength(2);
  });
});
