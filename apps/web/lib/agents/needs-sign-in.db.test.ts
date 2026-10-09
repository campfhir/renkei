/**
 * The sign-in re-queue against a real database (skipped without
 * DATABASE_URL): only THIS owner's runs parked for their key go back to
 * the queue, one message each; a run waiting on an approval, another
 * owner's parked run and a finished run are left alone.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { CURRENT_STEPS_VERSION } from '@renkei/agents';
import { ok } from '@campfhir/safe-functions/helpers';
import type { QueueMessageInput, QueueProducer } from '@renkei/queue';
import { NEEDS_SIGN_IN, resumeRunsNeedingSignIn } from './needs-sign-in';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('resumeRunsNeedingSignIn', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const other = `other-${tenantId.slice(0, 8)}`;
  const agentId = randomUUID();
  const steps = { version: CURRENT_STEPS_VERSION, steps: [] };

  const seedRun = async (
    ownerSubject: string,
    status: string,
    errorKind: string | null
  ): Promise<string> => {
    const id = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id,
        agent_id: agentId,
        owner_subject: ownerSubject,
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify(steps),
        lineage: JSON.stringify([]),
        initial_state: JSON.stringify({}),
        status,
        error_kind: errorKind,
        error: errorKind ? 'Paused: sign in.' : null,
      })
      .execute();
    return id;
  };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `signin-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        owner_subject: owner,
        name: 'Parked agent',
        steps: JSON.stringify(steps),
        enabled: true,
      })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_runs`.execute(db);
    await sql`DELETE FROM agents`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
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

    expect(await resumeRunsNeedingSignIn(db, producer, tenantId, owner)).toBe(2);
    expect(sent.map((m) => m.payload).sort()).toEqual(
      [{ runId: parkedA }, { runId: parkedB }].sort()
    );
    expect(new Set(sent.map((m) => m.orderingKey))).toEqual(new Set([`agent:${agentId}`]));
    expect(new Set(sent.map((m) => m.type))).toEqual(new Set(['run']));

    const rows = await db
      .selectFrom('agent_runs')
      .select(['id', 'status', 'error_kind', 'error'])
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(parkedA)).toEqual({
      id: parkedA,
      status: 'queued',
      error_kind: null,
      error: null,
    });
    expect(byId.get(parkedB)).toEqual({
      id: parkedB,
      status: 'queued',
      error_kind: null,
      error: null,
    });
    expect(byId.get(approval)?.status).toBe('waiting');
    expect(byId.get(theirs)).toMatchObject({ status: 'waiting', error_kind: NEEDS_SIGN_IN });
    expect(byId.get(done)?.status).toBe('succeeded');

    // Nothing left to re-queue the second time around.
    expect(await resumeRunsNeedingSignIn(db, producer, tenantId, owner)).toBe(0);
    expect(sent).toHaveLength(2);
  });
});
