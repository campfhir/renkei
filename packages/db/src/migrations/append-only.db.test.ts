/**
 * The delegate's access log is append-only in the database itself
 * (migration 144): a trigger refuses UPDATE and DELETE, so a process that
 * can write the log cannot rewrite it. No store method updates or deletes
 * an access event, so this is checked here, against Postgres, with the
 * package's own connection.
 */

import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '../client';
import { getDataStore } from '../store/registry';

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('delegate_access_events is append-only', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it('refuses to update or delete a recorded event', async () => {
    const target = `append-only-${randomUUID()}`;
    await getDataStore().delegateAccessEvents.record({
      caller: 'test',
      op: 'keys/shred',
      subjectHash: null,
      target,
      outcome: 'ok',
      status: 200,
    });
    const recorded = (await getDataStore().delegateAccessEvents.recent(50)).find(
      (event) => event.target === target
    );
    expect(recorded).toBeDefined();
    if (!recorded) return;

    const db = getDatabase();
    if (!db.ok) throw new Error('database unavailable');
    await expect(
      db.val.deleteFrom('delegate_access_events').where('id', '=', recorded.id).execute()
    ).rejects.toThrow(/append-only/);
    await expect(
      db.val
        .updateTable('delegate_access_events')
        .set({ outcome: 'rewritten' })
        .where('id', '=', recorded.id)
        .execute()
    ).rejects.toThrow(/append-only/);

    const after = (await getDataStore().delegateAccessEvents.recent(50)).find(
      (event) => event.id === recorded.id
    );
    expect(after?.outcome).toBe('ok');
  });
});
