/**
 * batch_job_schedules CRUD against a real database (skipped without
 * DATABASE_URL) — this package's own store.test.ts stays unit-level (a fake
 * Kysely stand-in) because recordItemOutcome's interesting property is call
 * shape, but schedules.ts has no other exerciser yet (the worker's schedule
 * sweep reads/writes the table directly, not through this module — see its
 * own doc comment), so its CRUD is verified here directly.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { createSchedule, getSchedule, listSchedules, updateSchedule, deleteSchedule } from './schedules';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('batch_job_schedules store', () => {
  jest.setTimeout(20_000);

  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `sched-store-subject-${tenantId.slice(0, 8)}`;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `sched-store-test-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM batch_job_schedules WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('creates, reads, lists, updates, and deletes a schedule', async () => {
    const nextRunAt = new Date(Date.now() + 60_000);
    const created = await createSchedule(db, {
      tenantId,
      subject,
      name: `Nightly OCR ${randomUUID().slice(0, 8)}`,
      kind: 'document-ocr-pipeline',
      config: { shareId: 'share-1', path: '/inbox', grouping: { strategy: 'whole-file' } },
      scheduleConfig: { recurrences: [{ every: 'day', at: '02:00' }], timezone: 'UTC' },
      nextRunAt,
    });
    expect(created.enabled).toBe(true);
    expect(created.next_run_at?.getTime()).toBe(nextRunAt.getTime());
    expect(created.config).toEqual({ shareId: 'share-1', path: '/inbox', grouping: { strategy: 'whole-file' } });

    const fetched = await getSchedule(db, created.id, tenantId);
    expect(fetched?.name).toBe(created.name);

    const listed = await listSchedules(db, tenantId, subject);
    expect(listed.map((s) => s.id)).toContain(created.id);

    const updated = await updateSchedule(db, created.id, tenantId, {
      enabled: false,
      name: `${created.name} (renamed)`,
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe(`${created.name} (renamed)`);

    const deleted = await deleteSchedule(db, created.id, tenantId);
    expect(deleted).toBe(true);
    expect(await getSchedule(db, created.id, tenantId)).toBeUndefined();
  });

  it('enforces one name per tenant', async () => {
    const name = `Duplicate name ${randomUUID().slice(0, 8)}`;
    await createSchedule(db, {
      tenantId,
      subject,
      name,
      kind: 'document-ocr-pipeline',
      config: {},
      scheduleConfig: {},
      nextRunAt: new Date(),
    });

    await expect(
      createSchedule(db, {
        tenantId,
        subject,
        name,
        kind: 'document-ocr-pipeline',
        config: {},
        scheduleConfig: {},
        nextRunAt: new Date(),
      })
    ).rejects.toThrow();
  });

  it('scopes get/update/delete to the owning tenant', async () => {
    const otherTenantId = randomUUID();
    await db
      .insertInto('tenants')
      .values({ id: otherTenantId, slug: `sched-store-other-${otherTenantId.slice(0, 8)}` })
      .execute();
    try {
      const created = await createSchedule(db, {
        tenantId,
        subject,
        name: `Tenant-scoped ${randomUUID().slice(0, 8)}`,
        kind: 'document-ocr-pipeline',
        config: {},
        scheduleConfig: {},
        nextRunAt: new Date(),
      });

      expect(await getSchedule(db, created.id, otherTenantId)).toBeUndefined();
      expect(await updateSchedule(db, created.id, otherTenantId, { enabled: false })).toBeUndefined();
      expect(await deleteSchedule(db, created.id, otherTenantId)).toBe(false);

      // Still there under the real tenant.
      expect(await getSchedule(db, created.id, tenantId)).toBeDefined();
    } finally {
      await sql`DELETE FROM tenants WHERE id = ${otherTenantId}`.execute(db);
    }
  });
});
