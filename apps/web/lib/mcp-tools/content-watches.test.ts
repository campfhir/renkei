/**
 * Watch grant repair, against a real database (skipped without
 * DATABASE_URL). The property under test is the one that makes repair
 * cheap: the CURSOR survives every path — a takeover rebinds subject and
 * account without touching it, and a fresh watch on a scope some other
 * subject already indexed inherits it instead of starting from NULL (a
 * full re-read of the space).
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { upsertWatch, repairWatch } from './content-watches';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('watch repair and cursor inheritance', () => {
  const suiteId = randomUUID().slice(0, 8);
  const scopeKey = `ENG-${suiteId}`;
  const departed = `departed-user-${suiteId}`;
  const alice = `alice-${suiteId}`;
  const bob = `bob-${suiteId}`;
  const cursor = '2026-08-01T00:00:00.000Z';
  let watchId = '';

  /** The poller state of one person's watch on the scope. */
  const stateFor = async (subject: string) => {
    const watches = getDataStore().contentWatches;
    const watch = await watches.findForSubject(subject, 'jira', scopeKey);
    if (!watch) throw new Error(`no watch for ${subject}`);
    return { watch, state: await watches.getSyncState(watch.id) };
  };

  beforeAll(async () => {
    // The broken watch, reached the way the poller leaves one: watched by
    // a since-departed subject, a round recorded mid-history, then failing
    // every poll.
    const watches = getDataStore().contentWatches;
    await watches.watch(
      { subject: departed, accountId: 'dead-account' },
      { provider: 'jira', scopeType: 'project', scopeKey, scopeLabel: 'Engineering' }
    );
    const broken = await watches.findForSubject(departed, 'jira', scopeKey);
    if (!broken) throw new Error('the watch was not created');
    watchId = broken.id;
    await watches.recordRound(watchId, { cursor, items: 3, syncStatus: 'idle' });
    await watches.recordSyncFailure(watchId, 'No usable grant found');
  });

  afterAll(async () => {
    await closeDataStore();
  });

  it('rebinds the watch to the caller, keeping the cursor', async () => {
    const before = await getDataStore().contentWatches.getSyncState(watchId);
    expect(before).toMatchObject({ cursor, syncStatus: 'error' });

    const result = await repairWatch(
      { subject: alice, accountId: 'alice-account' },
      'jira',
      'project',
      scopeKey
    );
    expect(result).toEqual({ ok: true, repaired: 1 });

    const { watch, state } = await stateFor(alice);
    expect(watch.id).toBe(watchId);
    expect(watch.accountId).toBe('alice-account');
    expect(state?.cursor).toBe(cursor);
    expect(state?.lastError).toBeNull();
    expect(state?.syncStatus).toBe('idle');
    // NULL puts it at the head of the sweep's never-synced-first ordering.
    expect(state?.lastSyncedAt).toBeNull();
    expect(
      await getDataStore().contentWatches.findForSubject(departed, 'jira', scopeKey)
    ).toBeNull();
  });

  it('reports zero when no watch exists for the scope', async () => {
    const result = await repairWatch(
      { subject: alice, accountId: 'alice-account' },
      'jira',
      'project',
      `NOPE-${suiteId}`
    );
    expect(result).toEqual({ ok: true, repaired: 0 });
  });

  it('a fresh watch on an already-indexed scope inherits the cursor', async () => {
    const result = await upsertWatch(
      { subject: bob, accountId: 'bob-account' },
      'jira',
      'project',
      scopeKey,
      'Engineering'
    );
    expect(result).toEqual({ ok: true, created: true });

    const { state } = await stateFor(bob);
    expect(state?.cursor).toBe(cursor);
  });
});
