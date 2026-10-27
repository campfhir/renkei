/**
 * Attempt detail on the run page, against a real database and the
 * in-process delegate (skipped without DATABASE_URL): a finished attempt
 * stored the engine's way — structure in the clear, the content half one
 * `uenc1:` envelope under the owner's automation key — reads back whole
 * for the owner; a run whose owner's key is not available renders the
 * chat's locked-row marker in place of the summary and nothing of the
 * content; a row without an envelope passes through as it is.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { splitDetailForSealing } from '@renkei/agents';
import { delegateClient } from '@renkei/delegate-client';
import { useTestDelegate } from '@/lib/test-support/delegate';
import { getRunForAdmin, getRunForOwner } from './runs-view';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('run detail with sealed attempt content', () => {
  jest.setTimeout(30_000);
  const delegate = useTestDelegate();
  const suiteId = randomUUID();
  const owner = `owner-${suiteId.slice(0, 8)}`;
  const stranger = `stranger-${suiteId.slice(0, 8)}`;
  const definition = { instructions: '## Goal\n\nFind the ticket.', tools: ['jira_get_issue'] };
  const detail = {
    opening: 'Started by hand. PROJ-42',
    llmSummary: 'Found PROJ-42: patient Jane Doe cannot sign in.',
    finish: 'done',
    result: 'PROJ-42',
    toolCalls: [
      {
        tool: 'jira_get_issue',
        argsPreview: '{"issueKey":"PROJ-42"}',
        resultPreview: 'Jane Doe',
        resultChars: 8,
        durationMs: 5,
      },
    ],
    modelCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  };

  const agentsCreated: { ownerSubject: string; agentId: string }[] = [];

  /**
   * A run the engine finished: the agent saved, the run queued, started,
   * one turn opened and written with `storedDetail`, then the run settled.
   */
  async function seedRun(
    ownerSubject: string,
    status: string,
    storedDetail: unknown
  ): Promise<{ agentId: string; runId: string }> {
    const store = getDataStore();
    const agentId = randomUUID();
    const runId = randomUUID();
    await store.agents.create({
      id: agentId,
      ownerSubject,
      name: `agent-${agentId.slice(0, 8)}`,
      instructions: definition.instructions,
      tools: definition.tools,
      llmModelId: null,
      enabled: true,
      guardrails: null,
      canAskQuestions: false,
      autoAcceptActions: false,
    });
    agentsCreated.push({ ownerSubject, agentId });
    await store.agentRuns.createQueued({
      id: runId,
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
    await store.agentRuns.updateExecution(runId, { status: 'running', startedAt: new Date() });
    const turnId = randomUUID();
    const detailText = JSON.stringify(storedDetail);
    await store.agentRuns.openTurn({
      id: turnId,
      runId,
      stepId: 'turn',
      attempt: 1,
      detail: detailText,
    });
    await store.agentRuns.writeTurn(turnId, {
      status: status === 'failed' ? 'failed' : 'succeeded',
      toolCallCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      outcome: null,
      detail: detailText,
      finished: true,
    });
    await store.agentRuns.finishExecution(runId, {
      status,
      errorKind: null,
      error: status === 'failed' ? 'The run failed.' : null,
    });
    return { agentId, runId };
  }

  beforeAll(async () => {
    await delegate.enroll(owner);
  });

  afterAll(async () => {
    // Deleting an agent takes its runs, steps and batches with it.
    for (const { ownerSubject, agentId } of agentsCreated) {
      await getDataStore().agents.delete(ownerSubject, agentId);
    }
  });

  it('round-trips: the owner reads the attempt as the engine wrote it, and the row holds no content', async () => {
    const { clear, plaintext } = splitDetailForSealing(detail);
    const sealed = await delegateClient().sealForSubject(owner, [plaintext!], 'automation');
    if (!sealed.ok) throw new Error(sealed.err.type);
    const stored = { ...clear, sealed: sealed.val[0] };
    expect(JSON.stringify(stored)).not.toContain('PROJ-42');
    expect(JSON.stringify(stored)).not.toContain('Jane Doe');

    const { agentId, runId } = await seedRun(owner, 'succeeded', stored);
    const run = await getRunForOwner(owner, agentId, runId);
    expect(run?.attempts[0]?.detail).toEqual(detail);
    expect(run?.definition).toEqual(definition);
  });

  it('shows an admin nothing of a working run, and the staged batches only on a failed one', async () => {
    const working = await seedRun(stranger, 'succeeded', detail);
    const failed = await seedRun(stranger, 'failed', detail);
    // Each run staged one auto-accepted batch, which then ran to completion.
    for (const { runId, agentId } of [working, failed]) {
      const batchId = randomUUID();
      const runs = getDataStore().agentRuns;
      await runs.stageBatch({
        id: batchId,
        runId,
        agentId,
        ownerSubject: stranger,
        turn: 1,
        status: 'accepted',
        summary: 'Comment on PROJ-42',
        actions: [{ tool: 'jira_add_comment', args: { issueKey: 'PROJ-42' }, reason: 'r' }],
        reviewReason: null,
        acceptedBy: 'auto',
        decided: true,
        waitingUntil: null,
      });
      expect(await runs.claimBatch(batchId)).toBe(true);
      await runs.completeBatch(batchId, []);
    }
    const quiet = await getRunForAdmin(working.agentId, working.runId);
    expect(quiet?.attempts[0]?.redacted).toBe(true);
    expect(quiet?.batches[0]).toMatchObject({ actionCount: 1, status: 'completed' });
    expect(quiet?.batches[0]).not.toHaveProperty('actions');
    expect(JSON.stringify(quiet)).not.toContain('PROJ-42');

    const broken = await getRunForAdmin(failed.agentId, failed.runId);
    expect(broken?.batches[0]?.actions?.[0]?.tool).toBe('jira_add_comment');
  });

  it("renders the locked-row marker, and no content, when the owner's key is not available", async () => {
    const { clear } = splitDetailForSealing(detail);
    // A stranger who never enrolled: the delegate has no key to open with.
    const { agentId, runId } = await seedRun(stranger, 'failed', {
      ...clear,
      sealed: 'uenc1:not-openable',
    });
    const run = await getRunForAdmin(agentId, runId);
    const shown = run?.attempts[0]?.detail;
    expect(shown).toMatchObject({
      finish: 'done',
      sealedUnavailable: true,
      llmSummary: expect.stringContaining('[content unavailable:'),
      toolCalls: [{ tool: 'jira_get_issue', resultChars: 8, durationMs: 5 }],
    });
    expect(JSON.stringify(shown)).not.toContain('PROJ-42');
    expect(JSON.stringify(shown)).not.toContain('Jane Doe');
    expect(shown).not.toHaveProperty('sealed');
  });

  it('passes a pre-sealing plaintext row through as it is', async () => {
    const { agentId, runId } = await seedRun(owner, 'succeeded', detail);
    const run = await getRunForOwner(owner, agentId, runId);
    expect(run?.attempts[0]?.detail).toEqual(detail);
  });
});
