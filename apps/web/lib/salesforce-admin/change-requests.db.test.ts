/**
 * Salesforce admin change requests against a real database (skipped without
 * DATABASE_URL): a request is only its owner's, carries its validation, can
 * be claimed only while pending and unexpired — of two simultaneous claims
 * exactly one wins — and an apply cut off after its deploy started is not
 * "interrupted", since the deploy can still be read. The subjects are
 * per run; the requests stay behind, as a request's history does.
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
  recordDeployStarted,
  requestDescription,
  setStep,
  setValidation,
  startQueuedChange,
  stateOf,
  validationPassed,
} from './change-requests';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('salesforce_admin_change_requests', () => {
  const suiteId = randomUUID();
  const owner = `sfa-owner-${suiteId.slice(0, 8)}`;
  const stranger = `sfa-stranger-${suiteId.slice(0, 8)}`;
  const operator = `sfa-operator-${suiteId.slice(0, 8)}`;

  const propose = (connectorKey = 'uat') =>
    createChangeRequest({
      subject: owner,
      connectorKey,
      orgId: '00D000000000062EAA',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      kind: 'fields',
      title: 'Site Visit: add Outcome',
      reason: 'The program tracks outcomes now',
      payload: { files: { 'package.xml': '<Package/>' } },
    });

  /** A proposal filed as `createChangeRequest` files one, but out of time as it lands. */
  const proposeExpired = () =>
    getDataStore().salesforceChanges.create({
      subject: owner,
      agentId: null,
      connectorKey: 'uat',
      orgId: '00D000000000062EAA',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      kind: 'fields',
      title: 'Site Visit: add Outcome',
      reason: 'The program tracks outcomes now',
      payload: { files: { 'package.xml': '<Package/>' } },
      ttlHours: 0,
    });

  afterAll(async () => {
    await closeDataStore();
  });

  it('stores a proposal as pending for a day, its owner’s alone, with its validation', async () => {
    const change = await propose();
    expect(stateOf(change)).toBe('pending');
    expect((change.expiresAt.getTime() - change.createdAt.getTime()) / 3_600_000).toBeCloseTo(
      24,
      1
    );
    expect(change.validation).toBeNull();
    expect(await getChangeRequest(stranger, change.id)).toBeNull();

    await setValidation(change.id, {
      deployId: '0Af000000000001',
      done: true,
      success: true,
      status: 'Succeeded',
      failures: [],
      checkedAt: new Date().toISOString(),
    });
    const read = await getChangeRequest(owner, change.id);
    expect(validationPassed(read?.validation ?? null)).toBe(true);
    expect((await countPendingChangeRequests(owner)).get('uat')).toBeGreaterThanOrEqual(1);
    expect((await listChangeRequests(owner, { connectorKey: 'production' })).length).toBe(0);
  });

  it('lets exactly one of two simultaneous claims win, and finishes only the claimed row', async () => {
    const change = await propose();
    const claims = await Promise.all([
      claimChangeRequest(owner, change.id),
      claimChangeRequest(owner, change.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimChangeRequest(stranger, change.id)).toBe(false);

    await recordDeployStarted(change.id, { deployId: '0Af000000000002', operations: [] });
    const applying = await getChangeRequest(owner, change.id);
    // Long after, it is still the deploy's to finish, not "interrupted".
    expect(applying && stateOf(applying, new Date(Date.now() + 60 * 60_000))).toBe('applying');

    expect(
      await finishChangeRequest(change.id, {
        status: 'applied',
        results: {
          deployId: '0Af000000000002',
          operations: [{ label: 'Deploy', outcome: 'done' }],
        },
        appliedBy: owner,
      })
    ).toBe(true);
    // A second finish (a refresh racing the apply) changes nothing.
    expect(
      await finishChangeRequest(change.id, {
        status: 'failed',
        results: { operations: [] },
        appliedBy: owner,
      })
    ).toBe(false);
    expect((await getChangeRequest(owner, change.id))?.status).toBe('applied');
  });

  it('cancels only a pending request, and never claims an expired one', async () => {
    const change = await propose();
    expect(await cancelChangeRequest(stranger, change.id)).toBe(false);
    expect(await cancelChangeRequest(owner, change.id)).toBe(true);
    expect(await claimChangeRequest(owner, change.id)).toBe(false);

    const old = await proposeExpired();
    const expired = await getChangeRequest(owner, old.id);
    expect(expired && stateOf(expired)).toBe('expired');
    expect(await claimChangeRequest(owner, old.id)).toBe(false);
  });

  describe('the approval queue', () => {
    it('queues a pending proposal once, under the approving operator, and runs it from the queue', async () => {
      const change = await propose();
      const queued = await Promise.all([
        queueChangeRequest(change.id, operator),
        queueChangeRequest(change.id, owner),
      ]);
      expect(queued.filter(Boolean)).toHaveLength(1);

      const read = await getChangeRequestById(change.id);
      expect(read?.status).toBe('queued');
      // Whoever won, the requester is unchanged and an approver is recorded.
      expect(read?.subject).toBe(owner);
      expect([operator, owner]).toContain(read?.approvedBy);
      expect(read?.approvedAt).not.toBeNull();
      // A queued request can no longer be withdrawn or approved again.
      expect(await cancelChangeRequest(owner, change.id)).toBe(false);
      expect(await queueChangeRequest(change.id, operator)).toBe(false);
      expect((await listRunnableChanges(90_000, 100)).map((job) => job.id)).toContain(change.id);

      // Of two jobs, exactly one starts it.
      const started = await Promise.all([
        startQueuedChange(change.id),
        startQueuedChange(change.id),
      ]);
      expect(started.filter(Boolean)).toHaveLength(1);
      await setStep(change.id, 'Salesforce is deploying — 2 of 5 components');
      expect((await getChangeRequestById(change.id))?.step).toBe(
        'Salesforce is deploying — 2 of 5 components'
      );
      // A live job is not up for taking over...
      expect(await reclaimStaleChange(change.id)).toBe(false);
      expect((await listRunnableChanges(90_000, 100)).map((job) => job.id)).not.toContain(
        change.id
      );

      // ...until its heartbeat goes quiet (here: for longer than the short
      // staleness the sweep is asked about).
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
        results: { operations: [] },
        appliedBy: operator,
      });
      const done = await getChangeRequestById(change.id);
      expect(done?.status).toBe('applied');
      // The progress line goes with the job.
      expect(done?.step).toBeNull();
    });

    it('will not queue a request in words, or an expired proposal', async () => {
      const words = await createRequest({
        subject: stranger,
        connectorKey: 'uat',
        orgId: '00D000000000062EAA',
        instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
        title: 'Add an Outcome picklist',
        description: 'Site Visit needs an Outcome picklist: Completed, No show.',
      });
      expect(requestDescription(words.payload)).toContain('Outcome picklist');
      expect(await queueChangeRequest(words.id, operator)).toBe(false);

      const old = await proposeExpired();
      expect(await queueChangeRequest(old.id, operator)).toBe(false);
    });

    it('lets an operator see and decline anyone’s request, saying why, while a stranger cannot', async () => {
      const mine = await propose();
      expect(await cancelChangeRequest(stranger, mine.id)).toBe(false);
      expect(
        await cancelChangeRequest(operator, mine.id, {
          operator: true,
          note: 'Use the existing field',
        })
      ).toBe(true);
      const declined = await getChangeRequestById(mine.id);
      expect(declined?.status).toBe('cancelled');
      expect(declined?.resolution).toBe('Use the existing field');
      // The requester reads the note on their own copy.
      expect((await getChangeRequest(owner, mine.id))?.resolution).toBe('Use the existing field');
      expect((await listAllChangeRequests({ limit: 500 })).map((c) => c.id)).toContain(mine.id);
    });

    it('closes a request in words as built when an operator proposes it', async () => {
      const words = await createRequest({
        subject: stranger,
        connectorKey: 'uat',
        orgId: '00D000000000062EAA',
        instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
        title: 'Add a Visit Notes field',
        description: 'A long text field on Site Visit.',
      });
      const before = (await countAwaitingReview()).get('uat') ?? 0;
      const proposal = await propose();
      expect(await closeRequestAsProposed(words.id, proposal.id)).toBe(true);
      const closed = await getChangeRequestById(words.id);
      expect(closed?.status).toBe('cancelled');
      expect(closed?.resolution).toContain(proposal.id);
      // Only a request in words closes this way, and only once.
      expect(await closeRequestAsProposed(proposal.id, words.id)).toBe(false);
      expect(await closeRequestAsProposed(words.id, proposal.id)).toBe(false);
      // The queue counts what waits for an operator, not what is closed.
      expect((await countAwaitingReview()).get('uat') ?? 0).toBe(before);
    });
  });
});
