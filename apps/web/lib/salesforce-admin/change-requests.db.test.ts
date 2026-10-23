/**
 * Salesforce admin change requests against a real database (skipped without
 * DATABASE_URL): a request is only its owner's, carries its validation, can
 * be claimed only while pending and unexpired — of two simultaneous claims
 * exactly one wins — and an apply cut off after its deploy started is not
 * "interrupted", since the deploy can still be read.
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
  recordDeployStarted,
  setValidation,
  stateOf,
  validationPassed,
} from './change-requests';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('salesforce_admin_change_requests', () => {
  let db: Kysely<DB>;
  const suiteId = randomUUID();
  const owner = `sfa-owner-${suiteId.slice(0, 8)}`;
  const stranger = `sfa-stranger-${suiteId.slice(0, 8)}`;

  const propose = (connectorKey = 'uat') =>
    createChangeRequest(db, {
      subject: owner,
      connectorKey,
      orgId: '00D000000000062EAA',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      kind: 'fields',
      title: 'Site Visit: add Outcome',
      reason: 'The program tracks outcomes now',
      payload: { files: { 'package.xml': '<Package/>' } },
    });

  beforeAll(() => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
  });

  afterAll(async () => {
    await sql`DELETE FROM salesforce_admin_change_requests WHERE subject IN (${owner}, ${stranger})`.execute(
      db
    );
    await closeDatabase();
  });

  it('stores a proposal as pending for a day, its owner’s alone, with its validation', async () => {
    const change = await propose();
    expect(stateOf(change)).toBe('pending');
    expect((change.expiresAt.getTime() - change.createdAt.getTime()) / 3_600_000).toBeCloseTo(
      24,
      1
    );
    expect(change.validation).toBeNull();
    expect(await getChangeRequest(db, stranger, change.id)).toBeNull();

    await setValidation(db, change.id, {
      deployId: '0Af000000000001',
      done: true,
      success: true,
      status: 'Succeeded',
      failures: [],
      checkedAt: new Date().toISOString(),
    });
    const read = await getChangeRequest(db, owner, change.id);
    expect(validationPassed(read?.validation ?? null)).toBe(true);
    expect((await countPendingChangeRequests(db, owner)).get('uat')).toBeGreaterThanOrEqual(1);
    expect((await listChangeRequests(db, owner, { connectorKey: 'production' })).length).toBe(0);
  });

  it('lets exactly one of two simultaneous claims win, and finishes only the claimed row', async () => {
    const change = await propose();
    const claims = await Promise.all([
      claimChangeRequest(db, owner, change.id),
      claimChangeRequest(db, owner, change.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimChangeRequest(db, stranger, change.id)).toBe(false);

    await recordDeployStarted(db, change.id, { deployId: '0Af000000000002', operations: [] });
    const applying = await getChangeRequest(db, owner, change.id);
    // Long after, it is still the deploy's to finish, not "interrupted".
    expect(applying && stateOf(applying, new Date(Date.now() + 60 * 60_000))).toBe('applying');

    expect(
      await finishChangeRequest(db, change.id, {
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
      await finishChangeRequest(db, change.id, {
        status: 'failed',
        results: { operations: [] },
        appliedBy: owner,
      })
    ).toBe(false);
    expect((await getChangeRequest(db, owner, change.id))?.status).toBe('applied');
  });

  it('cancels only a pending request, and never claims an expired one', async () => {
    const change = await propose();
    expect(await cancelChangeRequest(db, stranger, change.id)).toBe(false);
    expect(await cancelChangeRequest(db, owner, change.id)).toBe(true);
    expect(await claimChangeRequest(db, owner, change.id)).toBe(false);

    const old = await propose();
    await sql`UPDATE salesforce_admin_change_requests SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${old.id}`.execute(
      db
    );
    const expired = await getChangeRequest(db, owner, old.id);
    expect(expired && stateOf(expired)).toBe('expired');
    expect(await claimChangeRequest(db, owner, old.id)).toBe(false);
  });
});
