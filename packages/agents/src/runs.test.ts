/**
 * `liveRunFor` and `requestRunCancel` against a real Postgres (DATABASE_URL,
 * or the suite skips itself — the fileshares store test set this
 * convention). Live SQL is the point: this exists to reflect a real
 * WHERE ... IN ('queued','running') against the actual `agent_runs` shape,
 * not to restate the query in a mock.
 */

import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '@renkei/db';
import { closeDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { liveRunFor, requestRunCancel } from './runs';

const url = process.env.DATABASE_URL;
const describeLive = url ? describe : describe.skip;

describeLive('liveRunFor (live database)', () => {
  let db: Kysely<DB>;
  let tenantId: string;
  let agentId: string;

  beforeAll(async () => {
    db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
    });
    const tenant = await db
      .insertInto('tenants')
      .values({ id: randomUUID(), slug: `runs-itest-${Date.now()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;

    const agent = await db
      .insertInto('agents')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        owner_subject: 'itest-owner@example.com',
        name: 'liveRunFor fixture',
        steps: JSON.stringify({ version: 8, steps: [] }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    agentId = agent.id;
  });

  afterAll(async () => {
    await db.deleteFrom('agents').where('id', '=', agentId).execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await db.destroy();
  });

  async function insertRun(status: string): Promise<string> {
    const runId = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: 'itest-owner@example.com',
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify({ version: 8, steps: [] }),
        status,
      })
      .execute();
    return runId;
  }

  afterEach(async () => {
    await db.deleteFrom('agent_runs').where('agent_id', '=', agentId).execute();
  });

  it('returns null when nothing is queued or running', async () => {
    await insertRun('succeeded');
    await insertRun('failed');
    expect(await liveRunFor(db, tenantId, agentId)).toBeNull();
  });

  it('finds a running run', async () => {
    const runId = await insertRun('running');
    expect(await liveRunFor(db, tenantId, agentId)).toEqual({ id: runId, status: 'running' });
  });

  it('finds a queued run, and ignores terminal ones alongside it', async () => {
    await insertRun('succeeded');
    const runId = await insertRun('queued');
    expect(await liveRunFor(db, tenantId, agentId)).toEqual({ id: runId, status: 'queued' });
  });

  it('never sees another agent’s run, or another tenant’s', async () => {
    const otherAgent = await db
      .insertInto('agents')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        owner_subject: 'itest-owner@example.com',
        name: 'a different agent',
        steps: JSON.stringify({ version: 8, steps: [] }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('agent_runs')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        agent_id: otherAgent.id,
        owner_subject: 'itest-owner@example.com',
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify({ version: 8, steps: [] }),
        status: 'running',
      })
      .execute();

    expect(await liveRunFor(db, tenantId, agentId)).toBeNull();
    await db.deleteFrom('agents').where('id', '=', otherAgent.id).execute();
  });
});

describeLive('requestRunCancel (live database)', () => {
  let db: Kysely<DB>;
  let tenantId: string;
  let agentId: string;
  const purger = agentJobsQueue().purger;

  beforeAll(async () => {
    db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
    });
    const tenant = await db
      .insertInto('tenants')
      .values({ id: randomUUID(), slug: `runs-cancel-itest-${Date.now()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;

    const agent = await db
      .insertInto('agents')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        owner_subject: 'itest-owner@example.com',
        name: 'requestRunCancel fixture',
        steps: JSON.stringify({ version: 8, steps: [] }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    agentId = agent.id;
  });

  afterAll(async () => {
    await db.deleteFrom('agents').where('id', '=', agentId).execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await db.destroy();
    // The purger goes through @renkei/db's own module-level singleton
    // (agentJobsQueue -> getDatabase()), a separate pool from this file's
    // own `db` above — left open, jest never exits.
    await closeDatabase();
  });

  async function insertRun(status: string): Promise<string> {
    const runId = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: 'itest-owner@example.com',
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify({ version: 8, steps: [] }),
        status,
      })
      .execute();
    return runId;
  }

  afterEach(async () => {
    await db.deleteFrom('actionable_items').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('agent_runs').where('agent_id', '=', agentId).execute();
  });

  it('reports not-found for an unknown run', async () => {
    expect(await requestRunCancel(db, purger, tenantId, agentId, randomUUID())).toEqual({
      outcome: 'not-found',
    });
  });

  it('reports already-final for a run that already finished', async () => {
    const runId = await insertRun('succeeded');
    expect(await requestRunCancel(db, purger, tenantId, agentId, runId)).toEqual({
      outcome: 'already-final',
      status: 'succeeded',
    });
  });

  it('cancels a queued run immediately, and discards its pending message', async () => {
    const runId = await insertRun('queued');
    const enqueued = await agentJobsQueue().producer.enqueue({
      tenantId,
      source: `agents:${agentId}`,
      type: 'run',
      payload: { runId },
      orderingKey: `agent:${agentId}`,
    });
    expect(enqueued.ok).toBe(true);

    expect(await requestRunCancel(db, purger, tenantId, agentId, runId)).toEqual({
      outcome: 'canceled',
    });

    const row = await db
      .selectFrom('agent_runs')
      .select(['status', 'finished_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('canceled');
    expect(row.finished_at).not.toBeNull();

    // The pending message it enqueued is gone, so a claim will never
    // re-execute it — belt and suspenders alongside the idempotent
    // redelivery check on the terminal status alone.
    const pending = await db
      .selectFrom('agent_jobs')
      .select(['id'])
      .where('tenant_id', '=', tenantId)
      .where('type', '=', 'run')
      .where('status', '=', 'pending')
      .execute();
    expect(pending).toHaveLength(0);
  });

  it('cancels a waiting run and expires its pending approval card', async () => {
    const runId = await insertRun('waiting');
    await db
      .updateTable('agent_runs')
      .set({ waiting_until: new Date(Date.now() + 3_600_000) })
      .where('id', '=', runId)
      .execute();
    const cardId = randomUUID();
    await db
      .insertInto('actionable_items')
      .values({
        id: cardId,
        tenant_id: tenantId,
        source: 'agents',
        kind: 'approval',
        status: 'suggested',
        title: 'Needs your OK',
        summary: 'Approve this?',
        evidence: JSON.stringify({}),
        run_id: runId,
        owner_subject: 'itest-owner@example.com',
        created_by_agent_id: agentId,
      })
      .execute();

    expect(await requestRunCancel(db, purger, tenantId, agentId, runId)).toEqual({
      outcome: 'canceled',
    });

    const row = await db
      .selectFrom('agent_runs')
      .select(['status', 'waiting_until', 'finished_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('canceled');
    expect(row.waiting_until).toBeNull();
    expect(row.finished_at).not.toBeNull();

    const card = await db
      .selectFrom('actionable_items')
      .select(['status', 'result'])
      .where('id', '=', cardId)
      .executeTakeFirstOrThrow();
    expect(card.status).toBe('expired');
    expect(card.result).toEqual({ reason: 'run-ended' });
  });

  it('only requests a cancel for a running run, leaving status alone', async () => {
    const runId = await insertRun('running');

    expect(await requestRunCancel(db, purger, tenantId, agentId, runId)).toEqual({
      outcome: 'cancel-requested',
    });

    const row = await db
      .selectFrom('agent_runs')
      .select(['status', 'cancel_requested_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('running');
    expect(row.cancel_requested_at).not.toBeNull();
  });
});
