/**
 * Jira admin change requests against a real database (skipped without
 * DATABASE_URL): a request is only ever its owner's, only a pending,
 * unexpired one can be claimed for applying, and of two simultaneous
 * claims exactly one wins — the guarantee that one click applies a
 * change once.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import {
  cancelChangeRequest,
  claimChangeRequest,
  countPendingChangeRequests,
  createChangeRequest,
  finishChangeRequest,
  getChangeRequest,
  listChangeRequests,
  stateOf,
} from './change-requests';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('jira_admin_change_requests', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const stranger = `stranger-${tenantId.slice(0, 8)}`;

  const propose = (title = 'Source (Ops): add “Vendor”') =>
    createChangeRequest(db, {
      tenantId,
      subject: owner,
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      kind: 'field_options',
      title,
      reason: 'Procurement asked for it',
      payload: { operations: [{ op: 'add', values: ['Vendor'] }] },
    });

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `jira-admin-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM jira_admin_change_requests WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('stores a proposal as pending, expiring in a day, and reads it back', async () => {
    const change = await propose();
    expect(change.status).toBe('pending');
    expect(stateOf(change)).toBe('pending');
    const hours = (change.expiresAt.getTime() - change.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);

    const read = await getChangeRequest(db, tenantId, owner, change.id);
    expect(read?.payload).toEqual({ operations: [{ op: 'add', values: ['Vendor'] }] });
    expect(read?.reason).toBe('Procurement asked for it');
  });

  it('is its owner’s alone: anyone else reads it as not found and cannot touch it', async () => {
    const change = await propose();
    expect(await getChangeRequest(db, tenantId, stranger, change.id)).toBeNull();
    expect(await claimChangeRequest(db, tenantId, stranger, change.id)).toBe(false);
    expect(await cancelChangeRequest(db, tenantId, stranger, change.id)).toBe(false);
    expect(await listChangeRequests(db, tenantId, stranger)).toEqual([]);
    // A malformed id is simply not found, not a database error.
    expect(await getChangeRequest(db, tenantId, owner, `${change.id}.`)).toBeNull();
  });

  it('lets exactly one of two simultaneous claims win', async () => {
    const change = await propose();
    const claims = await Promise.all([
      claimChangeRequest(db, tenantId, owner, change.id),
      claimChangeRequest(db, tenantId, owner, change.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await getChangeRequest(db, tenantId, owner, change.id))?.status).toBe('applying');

    await finishChangeRequest(db, change.id, {
      status: 'partial',
      appliedBy: owner,
      results: [
        { label: 'Add option “Vendor”', outcome: 'done' },
        { label: 'Disable “Legacy”', outcome: 'failed', detail: 'Jira answered 400.' },
      ],
    });
    const finished = await getChangeRequest(db, tenantId, owner, change.id);
    expect(finished?.status).toBe('partial');
    expect(finished?.appliedBy).toBe(owner);
    expect(finished?.results?.[1]).toEqual({
      label: 'Disable “Legacy”',
      outcome: 'failed',
      detail: 'Jira answered 400.',
    });
    // Decided: neither claimable nor cancellable again.
    expect(await claimChangeRequest(db, tenantId, owner, change.id)).toBe(false);
    expect(await cancelChangeRequest(db, tenantId, owner, change.id)).toBe(false);
  });

  it('refuses to claim an expired request, and leaves it out of the pending list', async () => {
    const change = await propose('Expired one');
    await sql`UPDATE jira_admin_change_requests SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${change.id}`.execute(
      db
    );
    const read = await getChangeRequest(db, tenantId, owner, change.id);
    expect(read && stateOf(read)).toBe('expired');
    expect(await claimChangeRequest(db, tenantId, owner, change.id)).toBe(false);
    const pending = await listChangeRequests(db, tenantId, owner, { pendingOnly: true });
    expect(pending.map((c) => c.id)).not.toContain(change.id);
  });

  it('cancels a pending request, and counts only what still waits', async () => {
    const before = await countPendingChangeRequests(db, tenantId, owner);
    const change = await propose('To be withdrawn');
    expect(await countPendingChangeRequests(db, tenantId, owner)).toBe(before + 1);
    expect(await cancelChangeRequest(db, tenantId, owner, change.id)).toBe(true);
    const cancelled = await getChangeRequest(db, tenantId, owner, change.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledAt).not.toBeNull();
    expect(await countPendingChangeRequests(db, tenantId, owner)).toBe(before);
  });

  it('reads an apply cut off mid-flight as interrupted', () => {
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 11 * 60 * 1000);
    expect(stateOf({ status: 'applying', expiresAt: now, updatedAt }, now)).toBe('interrupted');
    expect(stateOf({ status: 'applying', expiresAt: now, updatedAt: now }, now)).toBe('applying');
  });
});
