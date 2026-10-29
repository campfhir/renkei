/**
 * The batch-job schedule sweep against a real database (skipped without
 * DATABASE_URL) — apps/worker-agents/src/schedule-sweep.test.ts's own
 * precedent, adapted to batch_job_schedules/batch_jobs. The property that
 * matters most: two sweeps racing the same due schedule fire ONE batch —
 * the optimistic advance is the lock.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { InMemoryQueue } from '@renkei/queue';
import { createBatchScheduleSweep } from './schedule-sweep';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('batch-job schedule sweep', () => {
  jest.setTimeout(20_000);

  const suiteId = randomUUID();
  const subject = `sched-subject-${suiteId.slice(0, 8)}`;
  const created: string[] = [];

  afterAll(async () => {
    // Batches the sweep spawned stay, their schedule link cleared — the
    // subject is this run's own, so nothing else ever reads them.
    for (const id of created) await getDataStore().batchJobSchedules.delete(id);
    await closeDataStore();
  });

  async function seedSchedule(
    scheduleConfig: Record<string, unknown> = { recurrences: [{ every: 'hour' }], timezone: 'UTC' },
    config: Record<string, unknown> = {
      shareId: randomUUID(),
      path: '/',
      grouping: { strategy: 'whole-file' },
    }
  ): Promise<string> {
    const id = randomUUID();
    await getDataStore().batchJobSchedules.create({
      id,
      subject,
      name: `sched-batch-${id.slice(0, 8)}`,
      kind: 'document-ocr-pipeline',
      config,
      scheduleConfig,
      nextRunAt: new Date(Date.now() - 60_000),
    });
    created.push(id);
    return id;
  }

  it('fires a due schedule once, advances it, and creates a batch', async () => {
    const scheduleId = await seedSchedule();
    const queue = new InMemoryQueue();
    await createBatchScheduleSweep(queue.producer)();

    const batches = await getDataStore().batchJobs.list(subject, { scheduleId });
    expect(batches).toHaveLength(1);
    expect(batches[0].kind).toBe('document-ocr-pipeline');
    expect(batches[0].status).toBe('queued');

    const schedule = await getDataStore().batchJobSchedules.get(scheduleId);
    expect(schedule?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(schedule?.lastFiredAt).not.toBeNull();
    expect(schedule?.lastError).toBeNull();
  });

  it('two racing sweeps fire exactly one batch', async () => {
    const scheduleId = await seedSchedule();
    const queue = new InMemoryQueue();
    // Both sweeps read the same due row before either advances it — the
    // worst-case interleaving two replicas can produce.
    await Promise.all([
      createBatchScheduleSweep(queue.producer)(),
      createBatchScheduleSweep(queue.producer)(),
    ]);

    expect(await getDataStore().batchJobs.list(subject, { scheduleId })).toHaveLength(1);
  });

  it('turns off a malformed schedule instead of erroring forever', async () => {
    const scheduleId = await seedSchedule({ recurrence: { every: 'never' }, timezone: 'UTC' });

    const queue = new InMemoryQueue();
    await createBatchScheduleSweep(queue.producer)();

    const schedule = await getDataStore().batchJobSchedules.get(scheduleId);
    expect(schedule?.enabled).toBe(false);
    expect(schedule?.lastError).toBeTruthy();
  });
});
