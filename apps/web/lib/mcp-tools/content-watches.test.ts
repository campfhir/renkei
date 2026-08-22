/**
 * Watch grant repair, against a real database (skipped without
 * DATABASE_URL). The property under test is the one that makes repair
 * cheap: the CURSOR survives every path — a takeover rebinds subject and
 * account without touching it, and a fresh watch on a scope some other
 * subject already indexed inherits it instead of starting from NULL (a
 * full re-read of the space).
 */

import { randomUUID } from 'node:crypto';
import { getDatabase, closeDatabase, type DB } from '@renkei/db';
import type { Kysely } from 'kysely';
import { upsertWatch, repairWatch } from './content-watches';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('watch repair and cursor inheritance', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const scopeKey = `ENG-${randomUUID().slice(0, 8)}`;
  const cursor = '2026-08-01T00:00:00.000Z';

  beforeAll(async () => {
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('no database');
    db = dbResult.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `wr-${tenantId.slice(0, 8)}` })
      .execute();
    // The broken watch: owned by a departed subject, mid-history cursor,
    // failing every poll.
    await db
      .insertInto('content_watches')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        provider: 'jira',
        account_id: 'dead-account',
        subject: 'departed-user',
        scope_type: 'project',
        scope_key: scopeKey,
        scope_label: 'Engineering',
        cursor,
        sync_status: 'error',
        last_error: 'No usable grant found',
        last_synced_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('content_watches').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('rebinds the watch to the caller, keeping the cursor', async () => {
    const result = await repairWatch(
      { tenantId, subject: 'alice', accountId: 'alice-account' },
      'jira',
      'project',
      scopeKey
    );
    expect(result).toEqual({ ok: true, repaired: 1 });

    const row = await db
      .selectFrom('content_watches')
      .select(['subject', 'account_id', 'cursor', 'last_error', 'sync_status', 'last_synced_at'])
      .where('tenant_id', '=', tenantId)
      .where('scope_key', '=', scopeKey)
      .executeTakeFirstOrThrow();
    expect(row.subject).toBe('alice');
    expect(row.account_id).toBe('alice-account');
    expect(row.cursor).toBe(cursor);
    expect(row.last_error).toBeNull();
    expect(row.sync_status).toBe('idle');
    // NULL puts it at the head of the sweep's never-synced-first ordering.
    expect(row.last_synced_at).toBeNull();
  });

  it('reports zero when no watch exists for the scope', async () => {
    const result = await repairWatch(
      { tenantId, subject: 'alice', accountId: 'alice-account' },
      'jira',
      'project',
      'NOPE'
    );
    expect(result).toEqual({ ok: true, repaired: 0 });
  });

  it('a fresh watch on an already-indexed scope inherits the cursor', async () => {
    const result = await upsertWatch(
      { tenantId, subject: 'bob', accountId: 'bob-account' },
      'jira',
      'project',
      scopeKey,
      'Engineering'
    );
    expect(result).toEqual({ ok: true, created: true });

    const row = await db
      .selectFrom('content_watches')
      .select(['cursor'])
      .where('tenant_id', '=', tenantId)
      .where('scope_key', '=', scopeKey)
      .where('subject', '=', 'bob')
      .executeTakeFirstOrThrow();
    expect(row.cursor).toBe(cursor);
  });
});
