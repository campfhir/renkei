import type { CoachAnchor } from '@/lib/coach-marks/anchors';
import type { CoachMarkProgressView, CoachMarkTour } from '@/lib/coach-marks/types';
import {
  currentStep,
  decideStart,
  initCoachMarks,
  offersMute,
  parsePending,
  pendingValue,
  planStartTour,
  transition,
  type CoachMarksAction,
  type CoachMarksEffect,
  type CoachMarksState,
} from './provider.model';

const tour = (over: Partial<CoachMarkTour> & { id: string }): CoachMarkTour => ({
  area: 'Workspace',
  version: 1,
  title: over.id,
  description: '',
  startPath: `/${over.id}`,
  autoStart: true,
  audience: 'everyone',
  steps: [
    { id: 'one', title: 'One', body: 'One.' },
    { id: 'two', title: 'Two', body: 'Two.' },
    { id: 'three', title: 'Three', body: 'Three.' },
  ],
  ...over,
});

const welcome = tour({ id: 'welcome', startPath: '/' });
const agents = tour({ id: 'agents', requires: ['agents-new'] });
const admin = tour({ id: 'admin', audience: 'operators', requires: ['agents-list'] });
const walk = tour({
  id: 'walk',
  autoStart: false,
  steps: [
    { id: 'here', title: 'Here', body: 'Here.' },
    { id: 'there', title: 'There', body: 'There.', path: '/agents' },
  ],
});
const TOURS = [welcome, agents, admin, walk];

const T0 = Date.parse('2026-11-01T10:00:00.000Z');

const fresh = (over: Partial<Parameters<typeof initCoachMarks>[0]> = {}) =>
  initCoachMarks({ autoStart: true, progress: [], ...over });

/** Fold actions through the machine, collecting every effect in order. */
function play(state: CoachMarksState, ...actions: CoachMarksAction[]) {
  const effects: CoachMarksEffect[] = [];
  for (const action of actions) {
    const result = transition(state, action);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const reports = (effects: CoachMarksEffect[]) =>
  effects.flatMap((effect) =>
    effect.type === 'report' ? [`${effect.record.event}@${effect.record.step}`] : []
  );

const onScreen = (...anchors: CoachAnchor[]): ReadonlySet<CoachAnchor> => new Set(anchors);

describe('walking a tour', () => {
  it('starts at the first step and reports that it was viewed', () => {
    const { state, effects } = play(fresh(), {
      type: 'begin',
      tour: welcome,
      manual: false,
      now: T0,
    });
    expect(currentStep(state)?.id).toBe('one');
    expect(reports(effects)).toEqual(['viewed@0']);
    expect(effects[0]).toEqual({
      type: 'report',
      record: { tourId: 'welcome', version: 1, event: 'viewed', step: 0, stepsTotal: 3, at: T0 },
    });
  });

  it('Next moves on a step and reports the step reached; Finish on the last records a completion and closes it', () => {
    const { state, effects } = play(
      fresh(),
      { type: 'begin', tour: welcome, manual: false, now: T0 },
      { type: 'next', path: '/', now: T0 + 1000 },
      { type: 'next', path: '/', now: T0 + 2000 },
      { type: 'next', path: '/', now: T0 + 3000 }
    );
    expect(reports(effects)).toEqual(['viewed@0', 'step@1', 'step@2', 'completed@2']);
    expect(state.active).toBeNull();
    expect(state.progress.get('welcome')).toMatchObject({
      status: 'completed',
      stepReached: 2,
      completedCount: 1,
      viewCount: 1,
    });
  });

  it('Back goes back a step without reporting, and does nothing on the first', () => {
    const started = play(fresh(), { type: 'begin', tour: welcome, manual: false, now: T0 });
    const atFirst = transition(started.state, { type: 'back' });
    expect(atFirst.state).toBe(started.state);
    const { state, effects } = play(
      started.state,
      { type: 'next', path: '/', now: T0 + 1 },
      { type: 'back' }
    );
    expect(currentStep(state)?.id).toBe('one');
    expect(reports(effects)).toEqual(['step@1']);
    // Going back never lowers how far they got.
    expect(state.progress.get('welcome')?.stepReached).toBe(1);
  });

  it('Skip records a dismissal at the step it happened on and closes the tour', () => {
    const { state, effects } = play(
      fresh(),
      { type: 'begin', tour: agents, manual: false, now: T0 },
      { type: 'next', path: '/agents', now: T0 + 1 },
      { type: 'skip', path: '/agents', now: T0 + 2 }
    );
    expect(reports(effects)).toEqual(['viewed@0', 'step@1', 'dismissed@1']);
    expect(state.active).toBeNull();
    expect(state.progress.get('agents')).toMatchObject({
      status: 'dismissed',
      stepReached: 1,
      dismissedCount: 1,
    });
  });

  it('a step that lives on another page takes the person there before it reports', () => {
    const { effects } = play(
      fresh(),
      { type: 'begin', tour: walk, manual: false, now: T0 },
      { type: 'next', path: '/walk', now: T0 + 1 }
    );
    expect(effects.slice(1).map((effect) => effect.type)).toEqual(['navigate', 'report']);
    expect(effects[1]).toEqual({ type: 'navigate', path: '/agents' });
  });

  it('a step on the page already in front does not navigate', () => {
    const { effects } = play(
      fresh(),
      { type: 'begin', tour: walk, manual: false, now: T0 },
      { type: 'next', path: '/agents', now: T0 + 1 }
    );
    expect(effects.some((effect) => effect.type === 'navigate')).toBe(false);
  });

  it('presses with no tour running do nothing', () => {
    const state = fresh();
    for (const action of [
      { type: 'next', path: '/', now: T0 },
      { type: 'back' },
      { type: 'skip', path: '/', now: T0 },
    ] satisfies CoachMarksAction[]) {
      expect(transition(state, action)).toEqual({ state, effects: [] });
    }
  });

  it('reports made in the same millisecond still go out in order, each later than the last', () => {
    const { effects } = play(
      fresh(),
      { type: 'begin', tour: welcome, manual: false, now: T0 },
      { type: 'next', path: '/', now: T0 },
      { type: 'skip', path: '/', now: T0 - 5 }
    );
    const ats = effects.flatMap((effect) => (effect.type === 'report' ? [effect.record.at] : []));
    expect(ats).toEqual([T0, T0 + 1, T0 + 2]);
  });

  it('a replay is a second pass: the first completion is still counted', () => {
    const finished = play(
      fresh(),
      { type: 'begin', tour: walk, manual: false, now: T0 },
      { type: 'next', path: '/agents', now: T0 + 1 },
      { type: 'next', path: '/agents', now: T0 + 2 }
    );
    const { state } = play(
      finished.state,
      { type: 'begin', tour: walk, manual: true, now: T0 + 10 },
      { type: 'skip', path: '/walk', now: T0 + 11 }
    );
    expect(state.progress.get('walk')).toMatchObject({
      status: 'dismissed',
      viewCount: 2,
      completedCount: 1,
      dismissedCount: 1,
    });
  });
});

describe('"Don\'t show tutorials" and the switch', () => {
  it('is offered on a tour that started unasked, not on one they asked for', () => {
    expect(offersMute(fresh())).toBe(false);
    expect(
      offersMute(
        transition(fresh(), { type: 'begin', tour: welcome, manual: false, now: T0 }).state
      )
    ).toBe(true);
    expect(
      offersMute(transition(fresh(), { type: 'begin', tour: welcome, manual: true, now: T0 }).state)
    ).toBe(false);
  });

  it('turns auto-start off, saves that, and skips the tour on screen', () => {
    const { state, effects } = play(
      fresh(),
      { type: 'begin', tour: admin, manual: false, now: T0 },
      { type: 'mute', path: '/admin', now: T0 + 1 }
    );
    expect(state.autoStart).toBe(false);
    expect(state.active).toBeNull();
    expect(effects.slice(1)).toEqual([
      { type: 'save-auto-start', value: false },
      expect.objectContaining({
        type: 'report',
        record: expect.objectContaining({ event: 'dismissed', tourId: 'admin' }),
      }),
    ]);
  });

  it('the switch on the Tutorials page saves the new setting', () => {
    const { state, effects } = play(fresh({ autoStart: false }), {
      type: 'auto-start-set',
      value: true,
    });
    expect(state.autoStart).toBe(true);
    expect(effects).toEqual([{ type: 'save-auto-start', value: true }]);
  });
});

describe('when a tour starts unasked', () => {
  const decide = (state: CoachMarksState, over: Partial<Parameters<typeof decideStart>[0]> = {}) =>
    decideStart({
      tours: TOURS,
      enabled: true,
      state,
      path: '/',
      mounted: onScreen(),
      isOperator: false,
      pending: null,
      ...over,
    });

  it('a newcomer gets the first tour that belongs on the page', () => {
    expect(decide(fresh())).toEqual({ kind: 'auto', tour: welcome, clearPending: false });
  });

  it('with the organization switch off, nothing starts — not even a tour asked for by link', () => {
    expect(decide(fresh(), { enabled: false })).toEqual({ kind: 'none', clearPending: false });
    expect(decide(fresh(), { enabled: false, pending: { id: 'welcome', explicit: true } })).toEqual(
      { kind: 'none', clearPending: false }
    );
  });

  it("with the person's own auto-start off, nothing starts unasked", () => {
    expect(decide(fresh({ autoStart: false }))).toEqual({ kind: 'none', clearPending: false });
  });

  it('nothing starts while a tour is already running', () => {
    const running = transition(fresh(), {
      type: 'begin',
      tour: agents,
      manual: true,
      now: T0,
    }).state;
    expect(decide(running).kind).toBe('none');
  });

  it('a tour finished here does not come back, and the next one on the page takes its place on the next visit', () => {
    const finished = play(
      fresh(),
      { type: 'begin', tour: welcome, manual: false, now: T0 },
      { type: 'next', path: '/', now: T0 + 1 },
      { type: 'next', path: '/', now: T0 + 2 },
      { type: 'next', path: '/', now: T0 + 3 }
    ).state;
    // Still on the page it ended on: nothing.
    expect(decide(finished).kind).toBe('none');
    // Elsewhere, the settled tour is passed over for the next that belongs.
    expect(decide(finished, { path: '/agents', mounted: onScreen('agents-new') })).toEqual({
      kind: 'auto',
      tour: agents,
      clearPending: false,
    });
  });

  it('a skipped tour stays away too', () => {
    const skipped = play(
      fresh(),
      { type: 'begin', tour: welcome, manual: false, now: T0 },
      { type: 'skip', path: '/', now: T0 + 1 }
    ).state;
    expect(decide({ ...skipped, endedOn: null }, { path: '/elsewhere' })).toEqual({
      kind: 'none',
      clearPending: false,
    });
  });

  it('a page whose anchors are not on screen yet starts nothing until they are', () => {
    const seen = fresh({
      progress: [settled('welcome')],
    });
    expect(decide(seen, { path: '/agents' }).kind).toBe('none');
    expect(decide(seen, { path: '/agents', mounted: onScreen('agents-new') }).kind).toBe('auto');
  });

  it("an operator's tour starts only for an operator", () => {
    const seen = fresh({ progress: [settled('welcome'), settled('agents')] });
    expect(decide(seen, { mounted: onScreen('agents-list') }).kind).toBe('none');
    expect(decide(seen, { mounted: onScreen('agents-list'), isOperator: true })).toMatchObject({
      kind: 'auto',
      tour: admin,
    });
  });
});

describe('a tour asked for', () => {
  const decide = (over: Partial<Parameters<typeof decideStart>[0]>) =>
    decideStart({
      tours: TOURS,
      enabled: true,
      state: fresh({ autoStart: false }),
      path: '/',
      mounted: onScreen(),
      isOperator: false,
      pending: null,
      ...over,
    });

  it('from the Tutorials page starts once its page has its anchors, whatever auto-start says', () => {
    const pending = { id: 'agents', explicit: false };
    expect(decide({ pending, path: '/agents' })).toEqual({ kind: 'wait' });
    expect(decide({ pending, path: '/agents', mounted: onScreen('agents-new') })).toEqual({
      kind: 'requested',
      tour: agents,
      clearQuery: false,
    });
  });

  it('by a ?tour= link starts on the very page it opens, and the link is cleaned from the address', () => {
    expect(decide({ pending: { id: 'agents', explicit: true } })).toEqual({
      kind: 'requested',
      tour: agents,
      clearQuery: true,
    });
  });

  it('that does not exist, or is not theirs, is dropped and the page carries on as usual', () => {
    const state = fresh();
    expect(decide({ state, pending: { id: 'nope', explicit: true } })).toEqual({
      kind: 'auto',
      tour: welcome,
      clearPending: true,
    });
    expect(decide({ state, pending: { id: 'admin', explicit: true } })).toMatchObject({
      kind: 'auto',
      clearPending: true,
    });
  });
});

describe('the request left for another page', () => {
  it('a ?tour= in the address wins and is explicit', () => {
    expect(parsePending('agents', pendingValue('welcome', T0), T0)).toEqual({
      pending: { id: 'agents', explicit: true },
      stale: false,
    });
  });

  it('a stored request within the minute is picked up', () => {
    expect(parsePending(null, pendingValue('chat', T0), T0 + 59_000)).toEqual({
      pending: { id: 'chat', explicit: false },
      stale: false,
    });
  });

  it('one older than a minute, or malformed, is stale and cleared', () => {
    expect(parsePending(null, pendingValue('chat', T0), T0 + 61_000)).toEqual({
      pending: null,
      stale: true,
    });
    expect(parsePending(null, '|123', T0)).toEqual({ pending: null, stale: true });
    expect(parsePending(null, 'chat|soon', T0)).toEqual({ pending: null, stale: true });
  });

  it('nothing asked for is nothing', () => {
    expect(parsePending(null, null, T0)).toEqual({ pending: null, stale: false });
  });
});

describe('Start and Replay', () => {
  const plan = (over: Partial<Parameters<typeof planStartTour>[0]>) =>
    planStartTour({
      tours: TOURS,
      tourId: 'agents',
      enabled: true,
      path: '/tutorials',
      mounted: onScreen(),
      ...over,
    });

  it("runs at once when this is already the tour's page", () => {
    expect(plan({ mounted: onScreen('agents-new') })).toEqual({ kind: 'begin', tour: agents });
  });

  it('otherwise goes to its start page, with the address as the fallback when storage is out', () => {
    expect(plan({})).toEqual({
      kind: 'go',
      tour: agents,
      path: '/agents',
      fallback: '/agents?tour=agents',
    });
  });

  it('does nothing with the organization switch off, or for a tour that does not exist', () => {
    expect(plan({ enabled: false })).toEqual({ kind: 'none' });
    expect(plan({ tourId: 'nope' })).toEqual({ kind: 'none' });
  });
});

function settled(tourId: string): CoachMarkProgressView {
  return {
    tourId,
    version: 1,
    status: 'completed',
    stepReached: 2,
    stepsTotal: 3,
    viewCount: 1,
    completedCount: 1,
    dismissedCount: 0,
    firstViewedAt: '2026-01-01T00:00:00.000Z',
    lastViewedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
    dismissedAt: null,
    reportedAt: '2026-01-01T00:00:00.000Z',
  };
}
