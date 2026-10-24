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
  closeRequestAsProposed,
  countAwaitingReview,
  countPendingChangeRequests,
  createChangeRequest,
  createRequest,
  finishChangeRequest,
  getChangeRequest,
  getChangeRequestById,
  listAllChangeRequests,
  listChangeRequests,
  listRunnableChanges,
  queueChangeRequest,
  reclaimStaleChange,
  requestDescription,
  setStep,
  startQueuedChange,
  stateOf,
} from './change-requests';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('jira_admin_change_requests', () => {
  let db: Kysely<DB>;
  const suiteId = randomUUID();
  const owner = `owner-${suiteId.slice(0, 8)}`;
  const stranger = `stranger-${suiteId.slice(0, 8)}`;
  const operator = `operator-${suiteId.slice(0, 8)}`;

  const propose = (title = 'Source (Ops): add “Vendor”') =>
    createChangeRequest(db, {
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
  });

  afterAll(async () => {
    await sql`DELETE FROM jira_admin_change_requests WHERE subject IN (${owner}, ${stranger}, ${operator})`.execute(db);
    await closeDatabase();
  });

  it('stores a proposal as pending, expiring in a day, and reads it back', async () => {
    const change = await propose();
    expect(change.status).toBe('pending');
    expect(stateOf(change)).toBe('pending');
    const hours = (change.expiresAt.getTime() - change.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);

    const read = await getChangeRequest(db, owner, change.id);
    expect(read?.payload).toEqual({ operations: [{ op: 'add', values: ['Vendor'] }] });
    expect(read?.reason).toBe('Procurement asked for it');
  });

  it('is its owner’s alone: anyone else reads it as not found and cannot touch it', async () => {
    const change = await propose();
    expect(await getChangeRequest(db, stranger, change.id)).toBeNull();
    expect(await claimChangeRequest(db, stranger, change.id)).toBe(false);
    expect(await cancelChangeRequest(db, stranger, change.id)).toBe(false);
    expect(await listChangeRequests(db, stranger)).toEqual([]);
    // A malformed id is simply not found, not a database error.
    expect(await getChangeRequest(db, owner, `${change.id}.`)).toBeNull();
  });

  it('lets exactly one of two simultaneous claims win', async () => {
    const change = await propose();
    const claims = await Promise.all([
      claimChangeRequest(db, owner, change.id),
      claimChangeRequest(db, owner, change.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await getChangeRequest(db, owner, change.id))?.status).toBe('applying');

    await finishChangeRequest(db, change.id, {
      status: 'partial',
      appliedBy: owner,
      results: [
        { label: 'Add option “Vendor”', outcome: 'done' },
        { label: 'Disable “Legacy”', outcome: 'failed', detail: 'Jira answered 400.' },
      ],
    });
    const finished = await getChangeRequest(db, owner, change.id);
    expect(finished?.status).toBe('partial');
    expect(finished?.appliedBy).toBe(owner);
    expect(finished?.results?.[1]).toEqual({
      label: 'Disable “Legacy”',
      outcome: 'failed',
      detail: 'Jira answered 400.',
    });
    // Decided: neither claimable nor cancellable again.
    expect(await claimChangeRequest(db, owner, change.id)).toBe(false);
    expect(await cancelChangeRequest(db, owner, change.id)).toBe(false);
  });

  it('refuses to claim an expired request, and leaves it out of the pending list', async () => {
    const change = await propose('Expired one');
    await sql`UPDATE jira_admin_change_requests SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${change.id}`.execute(
      db
    );
    const read = await getChangeRequest(db, owner, change.id);
    expect(read && stateOf(read)).toBe('expired');
    expect(await claimChangeRequest(db, owner, change.id)).toBe(false);
    const pending = await listChangeRequests(db, owner, { pendingOnly: true });
    expect(pending.map((c) => c.id)).not.toContain(change.id);
  });

  it('cancels a pending request, and counts only what still waits', async () => {
    const before = await countPendingChangeRequests(db, owner);
    const change = await propose('To be withdrawn');
    expect(await countPendingChangeRequests(db, owner)).toBe(before + 1);
    expect(await cancelChangeRequest(db, owner, change.id)).toBe(true);
    const cancelled = await getChangeRequest(db, owner, change.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledAt).not.toBeNull();
    expect(await countPendingChangeRequests(db, owner)).toBe(before);
  });

  it('reads an apply cut off mid-flight as interrupted', () => {
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 11 * 60 * 1000);
    expect(stateOf({ status: 'applying', expiresAt: now, updatedAt }, now)).toBe('interrupted');
    expect(stateOf({ status: 'applying', expiresAt: now, updatedAt: now }, now)).toBe('applying');
  });

  describe('the approval queue', () => {
    it('queues a pending proposal once, under the approving operator, and runs it from the queue', async () => {
      const change = await propose('Queued');
      const queued = await Promise.all([
        queueChangeRequest(db, change.id, operator),
        queueChangeRequest(db, change.id, owner),
      ]);
      expect(queued.filter(Boolean)).toHaveLength(1);

      const read = await getChangeRequestById(db, change.id);
      expect(read?.status).toBe('queued');
      expect(read?.subject).toBe(owner);
      expect([operator, owner]).toContain(read?.approvedBy);
      expect(await cancelChangeRequest(db, owner, change.id)).toBe(false);
      expect((await listRunnableChanges(db, 90_000, 100)).map((job) => job.id)).toContain(
        change.id
      );

      const started = await Promise.all([
        startQueuedChange(db, change.id),
        startQueuedChange(db, change.id),
      ]);
      expect(started.filter(Boolean)).toHaveLength(1);
      expect(await setStep(db, change.id, 'Applying the change in Jira')).toBe(true);
      expect((await getChangeRequestById(db, change.id))?.step).toBe(
        'Applying the change in Jira'
      );
      expect(await reclaimStaleChange(db, change.id)).toBe(false);

      await sql`UPDATE jira_admin_change_requests SET updated_at = NOW() - INTERVAL '5 minutes' WHERE id = ${change.id}`.execute(
        db
      );
      expect((await listRunnableChanges(db, 90_000, 100)).map((job) => job.id)).toContain(
        change.id
      );
      const takers = await Promise.all([
        reclaimStaleChange(db, change.id),
        reclaimStaleChange(db, change.id),
      ]);
      expect(takers.filter(Boolean)).toHaveLength(1);

      await finishChangeRequest(db, change.id, {
        status: 'applied',
        results: [{ label: 'Add “Vendor”', outcome: 'done' }],
        appliedBy: operator,
      });
      const done = await getChangeRequestById(db, change.id);
      expect(done?.status).toBe('applied');
      expect(done?.step).toBeNull();
      // Once finished the heartbeat has nothing to say.
      expect(await setStep(db, change.id, 'late')).toBe(false);
    });

    it('will not queue a request in words, and closes one as built when it is proposed', async () => {
      const words = await createRequest(db, {
        subject: stranger,
        cloudId: 'cloud-1',
        siteUrl: 'https://acme.atlassian.net',
        title: 'Add a Vendor option',
        description: 'The Source field in OPS needs Vendor.',
      });
      expect(requestDescription(words.payload)).toContain('Vendor');
      expect(await queueChangeRequest(db, words.id, operator)).toBe(false);

      const before = await countAwaitingReview(db);
      const proposal = await propose('Built from words');
      expect(await countAwaitingReview(db)).toBe(before + 1);
      expect(await closeRequestAsProposed(db, words.id, proposal.id)).toBe(true);
      expect(await closeRequestAsProposed(db, words.id, proposal.id)).toBe(false);
      const closed = await getChangeRequestById(db, words.id);
      expect(closed?.status).toBe('cancelled');
      expect(closed?.resolution).toContain(proposal.id);
    });

    it('lets an operator decline anyone’s request with a note, while a stranger cannot', async () => {
      const mine = await propose('To decline');
      expect(await cancelChangeRequest(db, stranger, mine.id)).toBe(false);
      expect(
        await cancelChangeRequest(db, operator, mine.id, { operator: true, note: 'Not this way' })
      ).toBe(true);
      expect((await getChangeRequest(db, owner, mine.id))?.resolution).toBe('Not this way');
      expect((await listAllChangeRequests(db, { limit: 500 })).map((c) => c.id)).toContain(mine.id);
    });
  });
});
