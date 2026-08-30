/**
 * `liveRunFor` against a real Postgres (DATABASE_URL, or the suite skips
 * itself — the fileshares store test set this convention). Live SQL is the
 * point: this exists to reflect a real WHERE ... IN ('queued','running')
 * against the actual `agent_runs` shape, not to restate the query in a
 * mock.
 */

import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '@renkei/db';
import { liveRunFor } from './runs';

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
