/**
 * Jira admin change requests against a real database (skipped without
 * DATABASE_URL): a request is only ever its owner's, only a pending,
 * unexpired one can be claimed for applying, and of two simultaneous
 * claims exactly one wins — the guarantee that one click applies a
 * change once. The subjects are per run; the requests stay behind, as a
 * request's history does.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
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
  const suiteId = randomUUID();
  const owner = `owner-${suiteId.slice(0, 8)}`;
  const stranger = `stranger-${suiteId.slice(0, 8)}`;
  const operator = `operator-${suiteId.slice(0, 8)}`;

  const propose = (title = 'Source (Ops): add “Vendor”') =>
    createChangeRequest({
      subject: owner,
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      kind: 'field_options',
      title,
      reason: 'Procurement asked for it',
      payload: { operations: [{ op: 'add', values: ['Vendor'] }] },
    });

  /** A proposal filed as `createChangeRequest` files one, but out of time as it lands. */
  const proposeExpired = (title: string) =>
    getDataStore().jiraChanges.create({
      subject: owner,
      agentId: null,
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      kind: 'field_options',
      title,
      reason: 'Procurement asked for it',
      payload: { operations: [{ op: 'add', values: ['Vendor'] }] },
      ttlHours: 0,
    });

  afterAll(async () => {
    await closeDataStore();
  });

  it('stores a proposal as pending, expiring in a day, and reads it back', async () => {
    const change = await propose();
    expect(change.status).toBe('pending');
    expect(stateOf(change)).toBe('pending');
    const hours = (change.expiresAt.getTime() - change.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);

    const read = await getChangeRequest(owner, change.id);
    expect(read?.payload).toEqual({ operations: [{ op: 'add', values: ['Vendor'] }] });
    expect(read?.reason).toBe('Procurement asked for it');
  });

  it('is its owner’s alone: anyone else reads it as not found and cannot touch it', async () => {
    const change = await propose();
    expect(await getChangeRequest(stranger, change.id)).toBeNull();
    expect(await claimChangeRequest(stranger, change.id)).toBe(false);
    expect(await cancelChangeRequest(stranger, change.id)).toBe(false);
    expect(await listChangeRequests(stranger)).toEqual([]);
    // A malformed id is simply not found, not a database error.
    expect(await getChangeRequest(owner, `${change.id}.`)).toBeNull();
  });

  it('lets exactly one of two simultaneous claims win', async () => {
    const change = await propose();
    const claims = await Promise.all([
      claimChangeRequest(owner, change.id),
      claimChangeRequest(owner, change.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await getChangeRequest(owner, change.id))?.status).toBe('applying');

    await finishChangeRequest(change.id, {
      status: 'partial',
      appliedBy: owner,
      results: [
        { label: 'Add option “Vendor”', outcome: 'done' },
        { label: 'Disable “Legacy”', outcome: 'failed', detail: 'Jira answered 400.' },
      ],
    });
    const finished = await getChangeRequest(owner, change.id);
    expect(finished?.status).toBe('partial');
    expect(finished?.appliedBy).toBe(owner);
    expect(finished?.results?.[1]).toEqual({
      label: 'Disable “Legacy”',
      outcome: 'failed',
      detail: 'Jira answered 400.',
    });
    // Decided: neither claimable nor cancellable again.
    expect(await claimChangeRequest(owner, change.id)).toBe(false);
    expect(await cancelChangeRequest(owner, change.id)).toBe(false);
  });

  it('refuses to claim an expired request, and leaves it out of the pending list', async () => {
    const change = await proposeExpired('Expired one');
    const read = await getChangeRequest(owner, change.id);
    expect(read && stateOf(read)).toBe('expired');
    expect(await claimChangeRequest(owner, change.id)).toBe(false);
    const pending = await listChangeRequests(owner, { pendingOnly: true });
    expect(pending.map((c) => c.id)).not.toContain(change.id);
  });

  it('cancels a pending request, and counts only what still waits', async () => {
    const before = await countPendingChangeRequests(owner);
    const change = await propose('To be withdrawn');
    expect(await countPendingChangeRequests(owner)).toBe(before + 1);
    expect(await cancelChangeRequest(owner, change.id)).toBe(true);
    const cancelled = await getChangeRequest(owner, change.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledAt).not.toBeNull();
    expect(await countPendingChangeRequests(owner)).toBe(before);
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
        queueChangeRequest(change.id, operator),
        queueChangeRequest(change.id, owner),
      ]);
      expect(queued.filter(Boolean)).toHaveLength(1);

      const read = await getChangeRequestById(change.id);
      expect(read?.status).toBe('queued');
      expect(read?.subject).toBe(owner);
      expect([operator, owner]).toContain(read?.approvedBy);
      expect(await cancelChangeRequest(owner, change.id)).toBe(false);
      expect((await listRunnableChanges(90_000, 100)).map((job) => job.id)).toContain(change.id);

      const started = await Promise.all([
        startQueuedChange(change.id),
        startQueuedChange(change.id),
      ]);
      expect(started.filter(Boolean)).toHaveLength(1);
      expect(await setStep(change.id, 'Applying the change in Jira')).toBe(true);
      expect((await getChangeRequestById(change.id))?.step).toBe('Applying the change in Jira');
      expect(await reclaimStaleChange(change.id)).toBe(false);

      // Its heartbeat goes quiet for longer than the short staleness the
      // sweep is asked about here.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const quiet = 100;
      expect((await listRunnableChanges(quiet, 100)).map((job) => job.id)).toContain(change.id);
      const takers = await Promise.all([
        reclaimStaleChange(change.id, quiet),
        reclaimStaleChange(change.id, quiet),
      ]);
      expect(takers.filter(Boolean)).toHaveLength(1);

      await finishChangeRequest(change.id, {
        status: 'applied',
        results: [{ label: 'Add “Vendor”', outcome: 'done' }],
        appliedBy: operator,
      });
      const done = await getChangeRequestById(change.id);
      expect(done?.status).toBe('applied');
      expect(done?.step).toBeNull();
      // Once finished the heartbeat has nothing to say.
      expect(await setStep(change.id, 'late')).toBe(false);
    });

    it('will not queue a request in words, and closes one as built when it is proposed', async () => {
      const words = await createRequest({
        subject: stranger,
        cloudId: 'cloud-1',
        siteUrl: 'https://acme.atlassian.net',
        title: 'Add a Vendor option',
        description: 'The Source field in OPS needs Vendor.',
      });
      expect(requestDescription(words.payload)).toContain('Vendor');
      expect(await queueChangeRequest(words.id, operator)).toBe(false);

      const before = await countAwaitingReview();
      const proposal = await propose('Built from words');
      expect(await countAwaitingReview()).toBe(before + 1);
      expect(await closeRequestAsProposed(words.id, proposal.id)).toBe(true);
      expect(await closeRequestAsProposed(words.id, proposal.id)).toBe(false);
      const closed = await getChangeRequestById(words.id);
      expect(closed?.status).toBe('cancelled');
      expect(closed?.resolution).toContain(proposal.id);
    });

    it('lets an operator decline anyone’s request with a note, while a stranger cannot', async () => {
      const mine = await propose('To decline');
      expect(await cancelChangeRequest(stranger, mine.id)).toBe(false);
      expect(
        await cancelChangeRequest(operator, mine.id, { operator: true, note: 'Not this way' })
      ).toBe(true);
      expect((await getChangeRequest(owner, mine.id))?.resolution).toBe('Not this way');
      expect((await listAllChangeRequests({ limit: 500 })).map((c) => c.id)).toContain(mine.id);
    });
  });
});
