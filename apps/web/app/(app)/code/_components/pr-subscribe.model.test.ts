/**
 * A pull request's subscribe row (pr-subscribe.model.ts), as a person
 * using it would describe it. The browser spec (pr-subscriptions.spec.ts)
 * keeps one subscribe through the route, read back on the Pulls page, the
 * recorded outcome drawn, and the phone width.
 */

import {
  boxEnabled,
  initialPrSubscribe,
  NONE,
  outcomeLine,
  prSubscribeReducer,
  saveRequest,
  shownOutcome,
  toggledSubscription,
  type PrSubscribeAction,
  type PrSubscribeState,
} from './pr-subscribe.model';

const run = (actions: PrSubscribeAction[], from: PrSubscribeState = initialPrSubscribe) =>
  actions.reduce(prSubscribeReducer, from);

const notSubscribed = () => run([{ type: 'loaded', subscription: null, lastEvent: null }]);

const MERGED = { conclusion: 'success', actionTaken: 'merged', observedAt: '2026-11-01T00:00:00Z' };

describe('reading the opt-in', () => {
  it('shows nothing until the read answers, then unsubscribed when there is no row', () => {
    expect(initialPrSubscribe.subscription).toBeNull();
    expect(notSubscribed().subscription).toEqual(NONE);
  });

  it('a PR not subscribed to offers Subscribe, with Fix and Merge off', () => {
    const state = notSubscribed();
    expect(boxEnabled(state, 'watch')).toBe(true);
    expect(boxEnabled(state, 'fix')).toBe(false);
    expect(boxEnabled(state, 'merge')).toBe(false);
  });
});

describe('subscribing', () => {
  it('subscribing turns Fix and Merge on, and sends the whole opt-in', () => {
    const state = run(
      [{ type: 'toggled', box: 'watch', checked: true }, { type: 'saved' }],
      notSubscribed()
    );
    expect(state.subscription).toEqual({ watchPipelines: true, autoFix: false, autoMerge: false });
    expect(boxEnabled(state, 'fix')).toBe(true);
    expect(boxEnabled(state, 'merge')).toBe(true);
    expect(saveRequest(90, toggledSubscription(state.subscription!, 'fix', true))).toEqual({
      method: 'POST',
      body: { prNumber: 90, watchPipelines: true, autoFix: true, autoMerge: false },
    });
  });

  it('nothing can be pressed while a change is in flight', () => {
    const sending = run([{ type: 'toggled', box: 'watch', checked: true }], notSubscribed());
    expect(sending.busy).toBe(true);
    expect(boxEnabled(sending, 'watch')).toBe(false);
    expect(boxEnabled(sending, 'fix')).toBe(false);
  });

  it('unsubscribing takes Fix and Merge off too, and sends a DELETE', () => {
    const subscribed = run([
      {
        type: 'loaded',
        subscription: { watchPipelines: true, autoFix: true, autoMerge: true },
        lastEvent: null,
      },
    ]);
    const next = toggledSubscription(subscribed.subscription!, 'watch', false);
    expect(next).toEqual(NONE);
    expect(saveRequest(90, next)).toEqual({ method: 'DELETE', body: { prNumber: 90 } });
    const state = run(
      [{ type: 'toggled', box: 'watch', checked: false }, { type: 'saved' }],
      subscribed
    );
    expect(boxEnabled(state, 'fix')).toBe(false);
  });

  it('a refused change puts the boxes back to what is saved, and says why', () => {
    const refused = run(
      [
        { type: 'toggled', box: 'watch', checked: true },
        { type: 'failed', error: 'No such project' },
      ],
      notSubscribed()
    );
    expect(refused.subscription).toEqual(NONE);
    expect(refused.error).toBe('No such project');
    expect(refused.busy).toBe(false);
    // The next press clears the reason.
    expect(run([{ type: 'toggled', box: 'watch', checked: true }], refused).error).toBeNull();
  });

  it('a refusal after earlier saves goes back to the last one saved', () => {
    const state = run(
      [
        { type: 'toggled', box: 'watch', checked: true },
        { type: 'saved' },
        { type: 'toggled', box: 'merge', checked: true },
        { type: 'failed', error: 'offline' },
      ],
      notSubscribed()
    );
    expect(state.subscription).toEqual({ watchPipelines: true, autoFix: false, autoMerge: false });
  });
});

describe('the outcome line', () => {
  it('shows the recorded outcome while subscribed', () => {
    const state = run([
      {
        type: 'loaded',
        subscription: { watchPipelines: true, autoFix: false, autoMerge: true },
        lastEvent: MERGED,
      },
    ]);
    expect(shownOutcome(state)).toBe('Pipeline succeeded — merged automatically.');
  });

  it('goes away on unsubscribing, and does not come back on subscribing again', () => {
    const subscribed = run([
      {
        type: 'loaded',
        subscription: { watchPipelines: true, autoFix: false, autoMerge: true },
        lastEvent: MERGED,
      },
    ]);
    const off = run(
      [{ type: 'toggled', box: 'watch', checked: false }, { type: 'saved' }],
      subscribed
    );
    expect(shownOutcome(off)).toBeNull();
    const on = run([{ type: 'toggled', box: 'watch', checked: true }, { type: 'saved' }], off);
    expect(shownOutcome(on)).toBeNull();
  });

  it('a refused unsubscribe keeps the outcome line', () => {
    const subscribed = run([
      {
        type: 'loaded',
        subscription: { watchPipelines: true, autoFix: false, autoMerge: true },
        lastEvent: MERGED,
      },
    ]);
    const refused = run(
      [
        { type: 'toggled', box: 'watch', checked: false },
        { type: 'failed', error: 'offline' },
      ],
      subscribed
    );
    expect(shownOutcome(refused)).toBe('Pipeline succeeded — merged automatically.');
  });

  it.each([
    ['success', 'merged', 'Pipeline succeeded — merged automatically.'],
    ['success', 'merge_failed', 'Pipeline succeeded, but the automatic merge failed.'],
    ['success', null, 'Pipeline succeeded.'],
    ['failure', 'fix_started', 'Pipeline failed — a fix attempt was started in this chat.'],
    ['failure', 'fix_failed', 'Pipeline failed, and the chat note could not be posted.'],
    ['failure', null, 'Pipeline failed.'],
    ['running', null, 'Pipeline is running.'],
    ['pending', null, 'Pipeline is pending.'],
    ['cancelled', null, 'Pipeline outcome unclear.'],
  ])('words %s / %s as “%s”', (conclusion, actionTaken, line) => {
    expect(outcomeLine({ conclusion, actionTaken, observedAt: '' })).toBe(line);
  });
});
