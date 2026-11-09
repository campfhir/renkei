import {
  canPress,
  cancelLabel,
  cancelReducer,
  initialCancelState,
  type CancelAction,
} from './cancel-button.model';

const fold = (...actions: CancelAction[]) => actions.reduce(cancelReducer, initialCancelState);

describe('the Cancel button', () => {
  it('a queued run reads Canceled as soon as the request answers', () => {
    const state = fold({ type: 'press' }, { type: 'answered', canceled: true });
    expect(cancelLabel(state)).toBe('Canceled');
    expect(canPress(state)).toBe(false);
  });

  it('a started run reads Canceling… until it stops', () => {
    const state = fold({ type: 'press' }, { type: 'answered', canceled: false });
    expect(cancelLabel(state)).toBe('Canceling…');
    expect(canPress(state)).toBe(false);
  });

  it('reads Canceling… while the request is out, and ignores a second press', () => {
    const busy = fold({ type: 'press' });
    expect(cancelLabel(busy)).toBe('Canceling…');
    expect(cancelReducer(busy, { type: 'press' })).toEqual(busy);
  });

  it('a refusal says why and offers the button again', () => {
    const state = fold(
      { type: 'press' },
      { type: 'refused', error: 'This run already succeeded.' }
    );
    expect(state).toEqual({ phase: 'idle', error: 'This run already succeeded.' });
    expect(cancelLabel(state)).toBe('✕ Cancel run');
    expect(canPress(state)).toBe(true);
  });
});
