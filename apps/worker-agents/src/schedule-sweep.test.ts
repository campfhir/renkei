/**
 * The schedule sweep against a real database (skipped without
 * DATABASE_URL). The property that matters most: two sweeps racing the
 * same due trigger fire ONE run — the optimistic advance is the lock.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { closeDatabase, getDatabase } from '@renkei/db';
import { InMemoryQueue } from '@renkei/queue';
import type { AgentStepsDoc } from '@renkei/agents';
import { createScheduleSweep } from './schedule-sweep';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('schedule sweep', () => {
  jest.setTimeout(20_000);

  const db = (() => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    return result.val;
  })();

  const tenantId = randomUUID();
  const subject = `sched-subject-${tenantId.slice(0, 8)}`;

  const steps: AgentStepsDoc = {
    version: 1,
    steps: [
      {
        id: randomUUID(),
        name: 'Say hello',
        instruction: [{ t: 'text', v: 'Say hello' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      },
    ],
  };

  beforeAll(async () => {
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `sched-test-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_runs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_triggers WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agents WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  async function seedSchedule(): Promise<{ agentId: string; triggerId: string }> {
    const agentId = randomUUID();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: subject,
        name: `sched-agent-${agentId.slice(0, 8)}`,
        steps: JSON.stringify(steps),
        enabled: true,
      })
      .execute();
    const triggerId = randomUUID();
    await db
      .insertInto('agent_triggers')
      .values({
        id: triggerId,
        tenant_id: tenantId,
        agent_id: agentId,
        kind: 'schedule',
        config: JSON.stringify({ recurrence: { every: 'hour' }, timezone: 'UTC' }),
        enabled: true,
        next_run_at: new Date(Date.now() - 60_000),
      })
      .execute();
    return { agentId, triggerId };
  }

  it('fires a due trigger once, advances it, and enqueues the run', async () => {
    const { agentId, triggerId } = await seedSchedule();
    const queue = new InMemoryQueue();
    await createScheduleSweep(db, queue.producer)();

    const runs = await db
      .selectFrom('agent_runs')
      .select(['id', 'trigger_kind', 'initial_state'])
      .where('agent_id', '=', agentId)
      .execute();
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger_kind).toBe('schedule');

    const trigger = await db
      .selectFrom('agent_triggers')
      .select(['next_run_at', 'last_fired_at', 'last_error'])
      .where('id', '=', triggerId)
      .executeTakeFirstOrThrow();
    expect(trigger.next_run_at && trigger.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(trigger.last_fired_at).not.toBeNull();
    expect(trigger.last_error).toBeNull();
  });

  it('two racing sweeps fire exactly one run', async () => {
    const { agentId } = await seedSchedule();
    const queue = new InMemoryQueue();
    // Both sweeps read the same due row before either advances it — the
    // worst-case interleaving two replicas can produce.
    await Promise.all([
      createScheduleSweep(db, queue.producer)(),
      createScheduleSweep(db, queue.producer)(),
    ]);

    const runs = await db
      .selectFrom('agent_runs')
      .select('id')
      .where('agent_id', '=', agentId)
      .execute();
    expect(runs).toHaveLength(1);
  });

  it('turns off a malformed schedule instead of erroring forever', async () => {
    const { triggerId } = await seedSchedule();
    await db
      .updateTable('agent_triggers')
      .set({ config: JSON.stringify({ recurrence: { every: 'never' } }) })
      .where('id', '=', triggerId)
      .execute();
    const queue = new InMemoryQueue();
    await createScheduleSweep(db, queue.producer)();

    const trigger = await db
      .selectFrom('agent_triggers')
      .select(['enabled', 'last_error'])
      .where('id', '=', triggerId)
      .executeTakeFirstOrThrow();
    expect(trigger.enabled).toBe(false);
    expect(trigger.last_error).toContain('malformed');
  });
});
