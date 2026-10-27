import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { CoachMarkProgressRecord } from './types';

function row(subject: string, tourId: string, updatedAt: string, status = 'viewed') {
  return {
    subject,
    tour_id: tourId,
    tour_version: 1,
    status,
    step_reached: 1,
    steps_total: 3,
    view_count: 2,
    completed_count: status === 'completed' ? 1 : 0,
    dismissed_count: 0,
    first_viewed_at: '2026-01-01T00:00:00.000Z',
    last_viewed_at: '2026-01-02T00:00:00.000Z',
    completed_at: status === 'completed' ? '2026-01-02T00:00:00.000Z' : null,
    dismissed_at: null,
    reported_at: '2026-01-02T00:00:00.000Z',
    updated_at: updatedAt,
  };
}

const fixture = {
  coach_mark_progress: [
    row('ann', 'welcome', '2026-01-03T00:00:00.000Z', 'completed'),
    row('ann', 'agents', '2026-01-05T00:00:00.000Z'),
    row('bob', 'welcome', '2026-01-04T00:00:00.000Z'),
    row('cat', 'chat', '2026-01-04T00:00:00.000Z'),
  ],
};

function record(
  tourId: string,
  patch: Partial<CoachMarkProgressRecord> = {}
): CoachMarkProgressRecord {
  return {
    tourId,
    version: 1,
    status: 'viewed',
    stepReached: 0,
    stepsTotal: 3,
    viewCount: 1,
    completedCount: 0,
    dismissedCount: 0,
    firstViewedAt: '2027-01-01T00:00:00.000Z',
    lastViewedAt: '2027-01-01T00:00:00.000Z',
    completedAt: null,
    dismissedAt: null,
    reportedAt: '2027-01-01T00:00:00.000Z',
    ...patch,
  };
}

export const coachMarkScenarios: Scenario<DataStore>[] = [
  {
    method: 'coachMarks.list',
    name: 'one person’s rows by tour',
    fixture,
    run: async (store) => [
      await store.coachMarks.list('ann'),
      await store.coachMarks.list('nobody'),
    ],
  },
  {
    method: 'coachMarks.apply',
    name: 'first report and follow-up; the first view stays',
    fixture,
    run: async (store) => {
      const seen: unknown[] = [];
      const first = await store.coachMarks.apply('dan', 'welcome', (existing) => {
        seen.push(existing);
        return record('welcome');
      });
      const second = await store.coachMarks.apply('ann', 'welcome', (existing) => {
        seen.push(existing);
        return record('welcome', { viewCount: (existing?.viewCount ?? 0) + 1 });
      });
      return {
        seen,
        first,
        second,
        dan: await store.coachMarks.list('dan'),
        ann: await store.coachMarks.list('ann'),
      };
    },
  },
  {
    method: 'coachMarks.listAll',
    name: 'most recently changed first, ties by subject and tour',
    fixture,
    run: (store) => store.coachMarks.listAll(),
  },
];
