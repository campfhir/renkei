/**
 * The batch-job schedule sweep against a real database (skipped without
 * DATABASE_URL) — apps/worker-agents/src/schedule-sweep.test.ts's own
 * precedent, adapted to batch_job_schedules/batch_jobs. The property that
 * matters most: two sweeps racing the same due schedule fire ONE batch —
 * the optimistic advance is the lock.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { InMemoryQueue } from '@renkei/queue';
import { createBatchScheduleSweep } from './schedule-sweep';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('batch-job schedule sweep', () => {
  jest.setTimeout(20_000);

  // Acquired in beforeAll, not at describe-collection time — see
  // schedule-sweep.test.ts's own comment on why (describe.skip still runs
  // its callback to register tests).
  let db: Kysely<DB>;

  const tenantId = randomUUID();
  const subject = `sched-subject-${tenantId.slice(0, 8)}`;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `batch-sched-test-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM batch_jobs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM batch_job_schedules WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  async function seedSchedule(
    scheduleConfig: Record<string, unknown> = { recurrences: [{ every: 'hour' }], timezone: 'UTC' },
    config: Record<string, unknown> = { shareId: randomUUID(), path: '/', grouping: { strategy: 'whole-file' } }
  ): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('batch_job_schedules')
      .values({
        id,
        tenant_id: tenantId,
        subject,
        name: `sched-batch-${id.slice(0, 8)}`,
        kind: 'document-ocr-pipeline',
        config: JSON.stringify(config),
        schedule_config: JSON.stringify(scheduleConfig),
        enabled: true,
        next_run_at: new Date(Date.now() - 60_000),
      })
      .execute();
    return id;
  }

  it('fires a due schedule once, advances it, and creates a batch', async () => {
    const scheduleId = await seedSchedule();
    const queue = new InMemoryQueue();
    await createBatchScheduleSweep(db, queue.producer)();

    const batches = await db
      .selectFrom('batch_jobs')
      .select(['id', 'schedule_id', 'kind', 'status'])
      .where('schedule_id', '=', scheduleId)
      .execute();
    expect(batches).toHaveLength(1);
    expect(batches[0].kind).toBe('document-ocr-pipeline');
    expect(batches[0].status).toBe('queued');

    const schedule = await db
      .selectFrom('batch_job_schedules')
      .select(['next_run_at', 'last_fired_at', 'last_error'])
      .where('id', '=', scheduleId)
      .executeTakeFirstOrThrow();
    expect(schedule.next_run_at && schedule.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(schedule.last_fired_at).not.toBeNull();
    expect(schedule.last_error).toBeNull();
  });

  it('two racing sweeps fire exactly one batch', async () => {
    const scheduleId = await seedSchedule();
    const queue = new InMemoryQueue();
    // Both sweeps read the same due row before either advances it — the
    // worst-case interleaving two replicas can produce.
    await Promise.all([
      createBatchScheduleSweep(db, queue.producer)(),
      createBatchScheduleSweep(db, queue.producer)(),
    ]);

    const batches = await db
      .selectFrom('batch_jobs')
      .select('id')
      .where('schedule_id', '=', scheduleId)
      .execute();
    expect(batches).toHaveLength(1);
  });

  it('turns off a malformed schedule instead of erroring forever', async () => {
    const scheduleId = await seedSchedule({ recurrence: { every: 'never' }, timezone: 'UTC' });

    const queue = new InMemoryQueue();
    await createBatchScheduleSweep(db, queue.producer)();

    const schedule = await db
      .selectFrom('batch_job_schedules')
      .select(['enabled', 'last_error'])
      .where('id', '=', scheduleId)
      .executeTakeFirstOrThrow();
    expect(schedule.enabled).toBe(false);
    expect(schedule.last_error).toBeTruthy();
  });
});
