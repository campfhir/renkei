/**
 * batch_job_schedules CRUD on the memory data store (the Postgres side of
 * the same store calls is packages/db's differential suite).
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  isDuplicateScheduleName,
} from './schedules';

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
});

afterAll(() => {
  resetDataStore();
});

const subject = 'sched-store-subject';

describe('batch_job_schedules store', () => {
  it('creates, reads, lists, updates, and deletes a schedule', async () => {
    const nextRunAt = new Date(Date.now() + 60_000);
    const created = await createSchedule({
      subject,
      name: 'Nightly OCR',
      kind: 'document-ocr-pipeline',
      config: { shareId: 'share-1', path: '/inbox', grouping: { strategy: 'whole-file' } },
      scheduleConfig: { recurrences: [{ every: 'day', at: '02:00' }], timezone: 'UTC' },
      nextRunAt,
    });
    expect(created.enabled).toBe(true);
    expect(created.next_run_at?.getTime()).toBe(nextRunAt.getTime());
    expect(created.config).toEqual({
      shareId: 'share-1',
      path: '/inbox',
      grouping: { strategy: 'whole-file' },
    });

    const fetched = await getSchedule(created.id);
    expect(fetched?.name).toBe(created.name);

    const listed = await listSchedules(subject);
    expect(listed.map((s) => s.id)).toContain(created.id);
    expect(await listSchedules('someone-else')).toEqual([]);

    const updated = await updateSchedule(created.id, {
      enabled: false,
      name: `${created.name} (renamed)`,
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe(`${created.name} (renamed)`);
    expect(updated?.schedule_config).toEqual(created.schedule_config);

    const deleted = await deleteSchedule(created.id);
    expect(deleted).toBe(true);
    expect(await getSchedule(created.id)).toBeUndefined();
    expect(await deleteSchedule(created.id)).toBe(false);
  });

  it('enforces one name per organization', async () => {
    const input = {
      subject,
      name: 'Duplicate name',
      kind: 'document-ocr-pipeline',
      config: {},
      scheduleConfig: {},
      nextRunAt: new Date(),
    };
    await createSchedule(input);
    const refusal = await createSchedule({ ...input, subject: 'other' }).catch(
      (error: unknown) => error
    );
    expect(isDuplicateScheduleName(refusal)).toBe(true);
    expect(isDuplicateScheduleName(new Error('something else'))).toBe(false);
  });
});
