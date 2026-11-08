import {
  initialTerminateState,
  terminateOutcome,
  terminateQuestion,
  terminateReducer,
  type TerminateAction,
} from './terminate-button.model';

const fold = (...actions: TerminateAction[]) =>
  actions.reduce(terminateReducer, initialTerminateState);

describe('the Terminate button', () => {
  it('asks before it terminates anything', () => {
    expect(fold({ type: 'press' })).toEqual({ phase: 'confirming' });
  });

  it('keeping the run puts the button back as it was', () => {
    expect(fold({ type: 'press' }, { type: 'keep' })).toEqual({ phase: 'idle' });
  });

  it('confirming sends it, and says how many were terminated', () => {
    const state = fold({ type: 'press' }, { type: 'confirm' }, { type: 'terminated', count: 3 });
    expect(state).toEqual({ phase: 'done', count: 3 });
    expect(terminateOutcome(state, false)).toBe('Terminated 3 stuck runs.');
    expect(
      terminateOutcome(
        fold({ type: 'press' }, { type: 'confirm' }, { type: 'terminated', count: 1 }),
        false
      )
    ).toBe('Terminated 1 stuck run.');
  });

  it('a press while it is working, or a confirm without asking, does nothing', () => {
    const busy = fold({ type: 'press' }, { type: 'confirm' });
    expect(terminateReducer(busy, { type: 'press' })).toEqual(busy);
    expect(fold({ type: 'confirm' })).toEqual(initialTerminateState);
  });

  it('a refusal says why, and the button can be pressed again', () => {
    const state = fold(
      { type: 'press' },
      { type: 'confirm' },
      {
        type: 'refused',
        error: 'This run has not been stuck for two hours yet — cancel it instead.',
      }
    );
    expect(terminateOutcome(state, true)).toMatch(/cancel it instead/);
    expect(terminateReducer(state, { type: 'press' })).toEqual({ phase: 'confirming' });
  });

  it('says plainly when there was nothing left to terminate', () => {
    const none = fold({ type: 'press' }, { type: 'confirm' }, { type: 'terminated', count: 0 });
    expect(terminateOutcome(none, false)).toBe('No stuck runs left to terminate.');
    expect(terminateOutcome(none, true)).toBe('Nothing left to terminate.');
  });

  it('asks about one run, or about every stuck one', () => {
    expect(terminateQuestion(true)).toMatch(/^Terminate this run\?/);
    expect(terminateQuestion(false)).toMatch(/every run stuck for over two hours/);
  });
});
