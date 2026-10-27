/**
 * The audit trails are append-only in the database itself: a trigger
 * refuses UPDATE and DELETE on the delegate's access log (migration 144)
 * and on the PHI access trail (migration 141), so a process that can write
 * a trail cannot rewrite it. No store method updates or deletes either, so
 * this is checked here, against Postgres, with the package's own
 * connection.
 */

import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '../client';
import { getDataStore } from '../store/registry';

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('append-only audit trails', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it('refuses to update or delete a delegate access event', async () => {
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

  it('refuses to update or delete a PHI access event', async () => {
    const subject = `append-only-${randomUUID()}`;
    await getDataStore().phiAccess.record({
      subject,
      agentId: null,
      runId: null,
      connector: 'mirth',
      instanceId: null,
      action: 'read',
      toolName: 'mirth_read_message',
      channelId: null,
      messageId: null,
      documentId: null,
      pathHash: null,
    });
    const [recorded] = await getDataStore().phiAccess.list({ subject, limit: 1 });
    expect(recorded).toBeDefined();
    if (!recorded) return;

    const db = getDatabase();
    if (!db.ok) throw new Error('database unavailable');
    await expect(
      db.val.deleteFrom('phi_access_events').where('id', '=', recorded.id).execute()
    ).rejects.toThrow(/append-only/);
    await expect(
      db.val
        .updateTable('phi_access_events')
        .set({ action: 'rewritten' })
        .where('id', '=', recorded.id)
        .execute()
    ).rejects.toThrow(/append-only/);

    const [after] = await getDataStore().phiAccess.list({ subject, limit: 1 });
    expect(after?.action).toBe('read');
  });
});
