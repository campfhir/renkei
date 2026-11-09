import {
  initialHaltState,
  haltOutcome,
  haltQuestion,
  haltReducer,
  type HaltAction,
} from './halt-button.model';

const fold = (...actions: HaltAction[]) => actions.reduce(haltReducer, initialHaltState);

describe('the Halt button', () => {
  it('asks before it halts anything', () => {
    expect(fold({ type: 'press' })).toEqual({ phase: 'confirming' });
  });

  it('keeping the run puts the button back as it was', () => {
    expect(fold({ type: 'press' }, { type: 'keep' })).toEqual({ phase: 'idle' });
  });

  it('confirming sends it, and says how many were halted', () => {
    const state = fold({ type: 'press' }, { type: 'confirm' }, { type: 'halted', count: 3 });
    expect(state).toEqual({ phase: 'done', count: 3 });
    expect(haltOutcome(state, false)).toBe('Halted 3 stuck runs.');
    expect(
      haltOutcome(fold({ type: 'press' }, { type: 'confirm' }, { type: 'halted', count: 1 }), false)
    ).toBe('Halted 1 stuck run.');
  });

  it('a press while it is working, or a confirm without asking, does nothing', () => {
    const busy = fold({ type: 'press' }, { type: 'confirm' });
    expect(haltReducer(busy, { type: 'press' })).toEqual(busy);
    expect(fold({ type: 'confirm' })).toEqual(initialHaltState);
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
    expect(haltOutcome(state, true)).toMatch(/cancel it instead/);
    expect(haltReducer(state, { type: 'press' })).toEqual({ phase: 'confirming' });
  });

  it('says plainly when there was nothing left to halt', () => {
    const none = fold({ type: 'press' }, { type: 'confirm' }, { type: 'halted', count: 0 });
    expect(haltOutcome(none, false)).toBe('No stuck runs left to halt.');
    expect(haltOutcome(none, true)).toBe('Nothing left to halt.');
  });

  it('asks about one run, or about every stuck one', () => {
    expect(haltQuestion(true)).toMatch(/^Halt this run\?/);
    expect(haltQuestion(false)).toMatch(/every run stuck for over two hours/);
  });
});
