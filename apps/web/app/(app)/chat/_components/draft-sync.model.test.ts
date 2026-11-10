/**
 * When the composer's unsent text is saved (draft-sync.model.ts).
 * chat-draft.spec.ts keeps that a draft really reaches the server and comes
 * back on reload and on another device, and that clearing removes it.
 */

import { initialDraftSync, saveAnswered, saveRequested, saveTiming } from './draft-sync.model';

describe('when a draft is saved', () => {
  it('typing waits for a pause; clearing the box saves at once', () => {
    expect(saveTiming('Remind me', '', true)).toBe('afterPause');
    expect(saveTiming('', 'Remind me', true)).toBe('now');
  });

  it('nothing is saved when the box matches what is saved, or the box is not a draft', () => {
    expect(saveTiming('Same', 'Same', true)).toBe('none');
    expect(saveTiming('Editing an old prompt', '', false)).toBe('none');
  });
});

describe('one save at a time, the newest last', () => {
  it('saves the text as it is when the save goes out', () => {
    const step = saveRequested(initialDraftSync(''), 'Remind me');
    expect(step.save).toBe('Remind me');
    expect(saveAnswered(step.state, true, 'Remind me')).toEqual({
      state: { saved: 'Remind me', inflight: null, again: false },
      save: null,
    });
  });

  it('a change during a save is saved after it, with the newest text', () => {
    const first = saveRequested(initialDraftSync(''), 'Remind');
    const during = saveRequested(first.state, 'Remind me');
    expect(during.save).toBeNull();
    const after = saveAnswered(during.state, true, 'Remind me which');
    expect(after.save).toBe('Remind me which');
    expect(after.state.saved).toBe('Remind');
    expect(saveAnswered(after.state, true, 'Remind me which').state.saved).toBe('Remind me which');
  });

  it('a change undone during a save sends nothing more', () => {
    const first = saveRequested(initialDraftSync(''), 'Remind');
    const during = saveRequested(first.state, 'Remind me');
    expect(saveAnswered(during.state, true, 'Remind').save).toBeNull();
  });

  it('a failed save leaves the saved copy behind, so the next change tries again', () => {
    const first = saveRequested(initialDraftSync('old'), 'new');
    const failed = saveAnswered(first.state, false, 'new');
    expect(failed).toEqual({ state: { saved: 'old', inflight: null, again: false }, save: null });
    expect(saveRequested(failed.state, 'new').save).toBe('new');
  });

  it('asking with nothing changed sends nothing', () => {
    expect(saveRequested(initialDraftSync('same'), 'same').save).toBeNull();
  });
});
