import { isSettled, pickAutoStartTour, slugRelativePath, stateLabel, toursFor } from './select';
import type { CoachMarkProgressView, CoachMarkTour } from './types';

const tour = (over: Partial<CoachMarkTour> & { id: string }): CoachMarkTour => ({
  version: 1,
  title: over.id,
  description: '',
  startPath: `/${over.id}`,
  autoStart: true,
  matches: (path) => path === `/${over.id}`,
  audience: 'everyone',
  steps: [{ id: 'one', title: 'One', body: 'One.' }],
  ...over,
});

const row = (over: Partial<CoachMarkProgressView> & { tourId: string }): CoachMarkProgressView => ({
  version: 1,
  status: 'completed',
  stepReached: 0,
  stepsTotal: 1,
  viewCount: 1,
  completedCount: 1,
  dismissedCount: 0,
  firstViewedAt: '2026-01-01T00:00:00.000Z',
  lastViewedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:00.000Z',
  dismissedAt: null,
  ...over,
});

const progressOf = (...rows: CoachMarkProgressView[]) =>
  new Map(rows.map((entry) => [entry.tourId, entry]));

describe('slugRelativePath', () => {
  it('strips the slug and keeps the rest', () => {
    expect(slugRelativePath('/e2e', 'e2e')).toBe('/');
    expect(slugRelativePath('/e2e/agents', 'e2e')).toBe('/agents');
    expect(slugRelativePath('/e2e/chat/abc', 'e2e')).toBe('/chat/abc');
  });

  it('leaves a path outside the slug alone', () => {
    expect(slugRelativePath('/e2e-other/agents', 'e2e')).toBe('/e2e-other/agents');
    expect(slugRelativePath('/', 'e2e')).toBe('/');
  });
});

describe('toursFor', () => {
  it('hides operator tours from everyone else, in registry order', () => {
    const tours = [
      tour({ id: 'a' }),
      tour({ id: 'ops', audience: 'operators' }),
      tour({ id: 'b' }),
    ];
    expect(toursFor(tours, false).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(toursFor(tours, true).map((entry) => entry.id)).toEqual(['a', 'ops', 'b']);
  });
});

describe('isSettled', () => {
  const current = tour({ id: 'a', version: 2 });

  it('is false with no row, or a row still mid-way', () => {
    expect(isSettled(undefined, current)).toBe(false);
    expect(isSettled(row({ tourId: 'a', version: 2, status: 'viewed' }), current)).toBe(false);
  });

  it('is true for a completion or a dismissal of the current edition', () => {
    expect(isSettled(row({ tourId: 'a', version: 2, status: 'completed' }), current)).toBe(true);
    expect(isSettled(row({ tourId: 'a', version: 2, status: 'dismissed' }), current)).toBe(true);
  });

  it('is false for an older edition — a reworked tour shows again', () => {
    expect(isSettled(row({ tourId: 'a', version: 1, status: 'completed' }), current)).toBe(false);
  });
});

describe('pickAutoStartTour', () => {
  const tours = [
    tour({ id: 'welcome', matches: (path) => path === '/' }),
    tour({ id: 'manual', autoStart: false, matches: () => true }),
    tour({ id: 'ops', audience: 'operators', matches: () => true }),
    tour({ id: 'agents' }),
  ];
  const base = { tours, isOperator: false, autoStart: true, progress: progressOf() };

  it('picks the first unseen auto-start tour that matches the path', () => {
    expect(pickAutoStartTour({ ...base, path: '/' })?.id).toBe('welcome');
    expect(pickAutoStartTour({ ...base, path: '/agents' })?.id).toBe('agents');
  });

  it('skips a settled tour, a manual one, and an operator one for a non-operator', () => {
    expect(
      pickAutoStartTour({ ...base, path: '/', progress: progressOf(row({ tourId: 'welcome' })) })
    ).toBeNull();
    expect(pickAutoStartTour({ ...base, path: '/nowhere' })).toBeNull();
    expect(pickAutoStartTour({ ...base, path: '/nowhere', isOperator: true })?.id).toBe('ops');
  });

  it('offers a tour again after a pass that was neither finished nor skipped', () => {
    const abandoned = row({ tourId: 'welcome', status: 'viewed', completedCount: 0 });
    expect(pickAutoStartTour({ ...base, path: '/', progress: progressOf(abandoned) })?.id).toBe(
      'welcome'
    );
  });

  it('picks nothing at all when the person has auto-start off', () => {
    expect(pickAutoStartTour({ ...base, path: '/', autoStart: false })).toBeNull();
  });
});

describe('stateLabel', () => {
  const current = tour({ id: 'a', version: 2 });

  it('names each state', () => {
    expect(stateLabel(undefined, current)).toBe('Not started');
    expect(stateLabel(row({ tourId: 'a', version: 2, status: 'viewed' }), current)).toBe(
      'In progress'
    );
    expect(stateLabel(row({ tourId: 'a', version: 2, status: 'completed' }), current)).toBe(
      'Completed'
    );
    expect(stateLabel(row({ tourId: 'a', version: 2, status: 'dismissed' }), current)).toBe(
      'Skipped'
    );
  });

  it('calls a settled row from an older edition Updated', () => {
    expect(stateLabel(row({ tourId: 'a', version: 1, status: 'completed' }), current)).toBe(
      'Updated'
    );
    expect(stateLabel(row({ tourId: 'a', version: 1, status: 'viewed' }), current)).toBe(
      'In progress'
    );
  });
});
