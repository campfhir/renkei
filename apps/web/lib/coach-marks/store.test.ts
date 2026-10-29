/**
 * The coach-mark store over the data store, on the memory implementation
 * (the Postgres side of the same calls is packages/db's contract suite):
 * a report goes through the reducer and lands, a straggler older than the
 * row changes nothing, a stored status the app does not know reads as
 * 'viewed', and the operator report groups rows by person with names from
 * the identity spine.
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { listCoachMarkProgress, listCoachMarkReport, recordCoachMarkEvent } from './store';

let store: MemoryDataStore;

beforeEach(() => {
  store = createMemoryDataStore();
  registerDataStore(store);
});

afterAll(() => {
  resetDataStore();
});

const report = (
  event: 'viewed' | 'step' | 'completed' | 'dismissed',
  step: number,
  at: number
) => ({
  tourId: 'welcome',
  version: 1,
  event,
  step,
  stepsTotal: 6,
  at,
});

describe('coach-mark store', () => {
  it('reduces each report onto the row, and ignores a straggler', async () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    expect((await recordCoachMarkEvent('ann', report('viewed', 0, start))).ok).toBe(true);
    const done = await recordCoachMarkEvent('ann', report('completed', 5, start + 60_000));
    expect(done.ok && done.val).toMatchObject({ status: 'completed', completedCount: 1 });

    const late = await recordCoachMarkEvent('ann', report('step', 2, start + 30_000));
    expect(late.ok && late.val).toMatchObject({ status: 'completed', stepReached: 5 });

    expect(await listCoachMarkProgress('ann')).toEqual([
      expect.objectContaining({ tourId: 'welcome', status: 'completed', completedCount: 1 }),
    ]);
    expect(await listCoachMarkProgress('bob')).toEqual([]);
  });

  it('reads an unknown stored status as viewed', async () => {
    await store.coachMarks.apply('ann', 'welcome', () => ({
      tourId: 'welcome',
      version: 1,
      status: 'something-new',
      stepReached: 0,
      stepsTotal: 6,
      viewCount: 1,
      completedCount: 0,
      dismissedCount: 0,
      firstViewedAt: '2026-01-01T00:00:00.000Z',
      lastViewedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      dismissedAt: null,
      reportedAt: '2026-01-01T00:00:00.000Z',
    }));
    expect((await listCoachMarkProgress('ann'))[0].status).toBe('viewed');
  });

  it('groups the operator report by person, newest activity first, named where known', async () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    await store.identities.upsert({
      subject: 'ann',
      email: 'ann@example.test',
      displayName: 'Ann',
      idpGroups: [],
    });
    await recordCoachMarkEvent('ann', report('viewed', 0, start));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordCoachMarkEvent('bob', report('viewed', 0, start));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordCoachMarkEvent('ann', { ...report('viewed', 0, start), tourId: 'agents' });

    expect(await listCoachMarkReport()).toEqual([
      {
        subject: 'ann',
        displayName: 'Ann',
        email: 'ann@example.test',
        tours: [
          expect.objectContaining({ tourId: 'agents' }),
          expect.objectContaining({ tourId: 'welcome' }),
        ],
      },
      {
        subject: 'bob',
        displayName: null,
        email: null,
        tours: [expect.objectContaining({ tourId: 'welcome' })],
      },
    ]);
  });

  it('reports null, not an empty report, when the store cannot be read', async () => {
    registerDataStore({
      ...store,
      coachMarks: { ...store.coachMarks, listAll: () => Promise.reject(new Error('down')) },
    });
    expect(await listCoachMarkReport()).toBeNull();
  });
});
