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
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { CURRENT_STEPS_VERSION, splitDetailForSealing } from '@renkei/agents';
import { delegateClient } from '@renkei/delegate-client';
import { useTestDelegate } from '@/lib/test-support/delegate';
import { getRunForAdmin, getRunForOwner } from './runs-view';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('run detail with sealed attempt content', () => {
  jest.setTimeout(30_000);
  const delegate = useTestDelegate();
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const stranger = `stranger-${tenantId.slice(0, 8)}`;
  const stepId = randomUUID();
  const steps = {
    version: CURRENT_STEPS_VERSION,
    steps: [
      {
        id: stepId,
        kind: 'action',
        name: 'Find the ticket',
        instruction: [],
        maxAttempts: 1,
        failureHandling: [],
      },
    ],
  };
  const detail = {
    resolvedInstruction: 'Find PROJ-42',
    promptText: 'You are executing one step… PROJ-42',
    llmSummary: 'Found PROJ-42: patient Jane Doe cannot sign in.',
    declaredOutcome: 'success',
    saveValue: 'PROJ-42',
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

  async function seedRun(
    ownerSubject: string,
    status: string,
    storedDetail: unknown
  ): Promise<{ agentId: string; runId: string }> {
    const agentId = randomUUID();
    const runId = randomUUID();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        owner_subject: ownerSubject,
        name: `agent-${agentId.slice(0, 8)}`,
        steps: JSON.stringify(steps),
        enabled: true,
      })
      .execute();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        agent_id: agentId,
        owner_subject: ownerSubject,
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify(steps),
        lineage: JSON.stringify([]),
        initial_state: JSON.stringify({}),
        status,
      })
      .execute();
    await db
      .insertInto('agent_run_steps')
      .values({
        id: randomUUID(),
        run_id: runId,
        step_id: stepId,
        step_index: 0,
        attempt: 1,
        status: status === 'failed' ? 'failed' : 'succeeded',
        detail: JSON.stringify(storedDetail),
      })
      .execute();
    return { agentId, runId };
  }

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await delegate.enroll(owner);
  });

  afterAll(async () => {
    await db.deleteFrom('agent_runs').execute();
    await db.deleteFrom('agents').execute();
    await db.deleteFrom('user_encryption_keys').execute();
  });

  it('round-trips: the owner reads the attempt as the engine wrote it, and the row holds no content', async () => {
    const { clear, plaintext } = splitDetailForSealing(detail);
    const sealed = await delegateClient().sealForSubject(
      owner,
      [plaintext!],
      'automation'
    );
    if (!sealed.ok) throw new Error(sealed.err.type);
    const stored = { ...clear, sealed: sealed.val[0] };
    expect(JSON.stringify(stored)).not.toContain('PROJ-42');
    expect(JSON.stringify(stored)).not.toContain('Jane Doe');

    const { agentId, runId } = await seedRun(owner, 'succeeded', stored);
    const run = await getRunForOwner(db, owner, agentId, runId);
    expect(run?.attempts[0]?.detail).toEqual(detail);
  });

  it("renders the locked-row marker, and no content, when the owner's key is not available", async () => {
    const { clear } = splitDetailForSealing(detail);
    // A stranger who never enrolled: the delegate has no key to open with.
    const { agentId, runId } = await seedRun(stranger, 'failed', {
      ...clear,
      sealed: 'uenc1:not-openable',
    });
    const run = await getRunForAdmin(db, agentId, runId);
    const shown = run?.attempts[0]?.detail;
    expect(shown).toMatchObject({
      declaredOutcome: 'success',
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
    const run = await getRunForOwner(db, owner, agentId, runId);
    expect(run?.attempts[0]?.detail).toEqual(detail);
  });
});
