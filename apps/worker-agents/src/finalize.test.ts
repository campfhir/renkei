/**
 * Chaining and the failure event, against a real database (skipped without
 * DATABASE_URL). What must hold: success starts every authorized chained
 * agent with the parent in its lineage; a cycle refuses with the reason on
 * the target trigger; failure emits exactly one run.failed event and no
 * chain.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { InMemoryQueue } from '@renkei/queue';
import type { AgentStepsDoc } from '@renkei/agents';
import { createFinalizeHook } from './finalize';
import type { FinalizedRun } from './engine';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('finalize hook', () => {
  jest.setTimeout(20_000);

  // Acquired in beforeAll, not at describe-collection time: describe.skip still
  // runs its callback to register tests, so acquiring the database here (when
  // this suite is skipped for lack of DATABASE_URL) would throw at collection
  // and fail the whole file instead of skipping it.
  let db: Kysely<DB>;

  const tenantId = randomUUID();
  const owner = `chain-owner-${tenantId.slice(0, 8)}`;

  const steps: AgentStepsDoc = {
    version: 1,
    steps: [
      {
        id: randomUUID(),
        name: 'Do the thing',
        instruction: [{ t: 'text', v: 'Do the thing' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      },
    ],
  };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `chain-test-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_runs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_triggers WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agents WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  async function seedAgent(name: string): Promise<string> {
    const agentId = randomUUID();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: owner,
        name: `${name}-${agentId.slice(0, 8)}`,
        steps: JSON.stringify(steps),
        enabled: true,
      })
      .execute();
    return agentId;
  }

  async function chainTrigger(targetAgentId: string, callerAgentId: string): Promise<string> {
    const triggerId = randomUUID();
    await db
      .insertInto('agent_triggers')
      .values({
        id: triggerId,
        tenant_id: tenantId,
        agent_id: targetAgentId,
        kind: 'agent',
        config: JSON.stringify({ callerAgentId }),
        enabled: true,
      })
      .execute();
    return triggerId;
  }

  async function seedRun(agentId: string, lineage: string[]): Promise<string> {
    const runId = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: owner,
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify(steps),
        lineage: JSON.stringify(lineage),
        depth: lineage.length,
        status: 'succeeded',
      })
      .execute();
    return runId;
  }

  /** A run started by a WebEx event trigger, thread coordinates in state. */
  async function seedWebexRun(agentId: string): Promise<string> {
    const triggerId = randomUUID();
    await db
      .insertInto('agent_triggers')
      .values({
        id: triggerId,
        tenant_id: tenantId,
        agent_id: agentId,
        kind: 'event',
        event_source: 'webex',
        event_type: 'message.received',
        config: JSON.stringify({ match: {} }),
        enabled: true,
      })
      .execute();
    const runId = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: owner,
        trigger_id: triggerId,
        trigger_kind: 'event',
        steps_snapshot: JSON.stringify(steps),
        lineage: JSON.stringify([]),
        initial_state: JSON.stringify({ roomId: 'room-1', messageId: 'msg-1', text: 'hello' }),
        status: 'succeeded',
      })
      .execute();
    return runId;
  }

  const finalized = (
    runId: string,
    agentId: string,
    status: 'succeeded' | 'failed'
  ): FinalizedRun => ({
    runId,
    tenantId,
    agentId,
    ownerSubject: owner,
    status,
    quiet: false,
    errorKind: status === 'failed' ? 'step_failed' : null,
    error: status === 'failed' ? 'Step "Do the thing" stopped the agent.' : null,
    vars: { theTicket: 'PROJ-42' },
  });

  it('starts the chained agent with the parent in its lineage', async () => {
    const a = await seedAgent('agent-a');
    const b = await seedAgent('agent-b');
    await chainTrigger(b, a);
    const parentRunId = await seedRun(a, []);

    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      db,
      agentQueue.producer,
      eventsQueue.producer
    )(finalized(parentRunId, a, 'succeeded'));

    const child = await db
      .selectFrom('agent_runs')
      .select(['agent_id', 'parent_run_id', 'lineage', 'depth', 'trigger_kind', 'initial_state'])
      .where('tenant_id', '=', tenantId)
      .where('agent_id', '=', b)
      .executeTakeFirstOrThrow();
    expect(child.parent_run_id).toBe(parentRunId);
    expect(child.lineage).toEqual([a]);
    expect(child.depth).toBe(1);
    expect(child.trigger_kind).toBe('agent');
    const state: { parentSummary?: unknown } =
      typeof child.initial_state === 'object' &&
      child.initial_state !== null &&
      !Array.isArray(child.initial_state)
        ? child.initial_state
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
      db,
      agentQueue.producer,
      eventsQueue.producer
    )(finalized(bRunId, b, 'succeeded'));

    const aRuns = await db
      .selectFrom('agent_runs')
      .select('id')
      .where('agent_id', '=', a)
      .execute();
    expect(aRuns).toHaveLength(0);

    const trigger = await db
      .selectFrom('agent_triggers')
      .select('last_error')
      .where('id', '=', backTrigger)
      .executeTakeFirstOrThrow();
    expect(trigger.last_error).toContain('already ran');
  });

  it('never posts an automatic thread reply — answering the room is a STEP', async () => {
    const agentId = await seedAgent('no-auto-reply');
    const runId = await seedWebexRun(agentId);
    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      db,
      agentQueue.producer,
      eventsQueue.producer
    )({
      ...finalized(runId, agentId, 'succeeded'),
      vars: { reply: 'a saved reply var must not leak into the room' },
    });
    expect(await eventsQueue.consumer.claim()).toBeNull();
  });

  it('a failed webex-triggered run emits only the owner notification', async () => {
    const agentId = await seedAgent('failnotify-a');
    const runId = await seedWebexRun(agentId);
    const agentQueue = new InMemoryQueue();
    const eventsQueue = new InMemoryQueue();
    await createFinalizeHook(
      db,
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
      db,
      agentQueue.producer,
      eventsQueue.producer
    )(finalized(runId, a, 'failed'));

    const event = await eventsQueue.consumer.claim();
    expect(event?.source).toBe('agents');
    expect(event?.type).toBe('run.failed');
    const bRuns = await db
      .selectFrom('agent_runs')
      .select('id')
      .where('agent_id', '=', b)
      .execute();
    expect(bRuns).toHaveLength(0);
  });
});
