/**
 * A notebook in the code pane: when it can be run, and what a run leaves
 * on screen.
 */

import {
  failedCellIndex,
  initialNotebookView,
  notebookViewReducer,
  readRunAnswer,
  runBlocker,
  runStatus,
  type NotebookViewAction,
  type RunContext,
  type RunSummary,
} from './notebook-view.model';

const after = (...actions: NotebookViewAction[]) =>
  actions.reduce(notebookViewReducer, initialNotebookView);

const runnable: RunContext = {
  canEdit: true,
  fromCheckout: true,
  editable: true,
  valid: true,
  codeCells: 3,
  saving: false,
  conflict: false,
};

const ranAll: RunSummary = { engine: 'builtin', ran: 3, total: 3, seconds: 1.42, failed: null };
const stoppedAtTwo: RunSummary = {
  engine: 'kernel',
  ran: 2,
  total: 3,
  seconds: 12.4,
  failed: { index: 4, number: 2, ename: 'KeyError', evalue: "'revenue'" },
};

describe('opening a notebook', () => {
  it('shows the cells, with nothing said about a run', () => {
    expect(initialNotebookView.mode).toBe('notebook');
    expect(runStatus(initialNotebookView)).toBeNull();
  });

  it('Source and Notebook switch between the file and its cells', () => {
    expect(after({ type: 'modeChosen', mode: 'source' }).mode).toBe('source');
    expect(
      after({ type: 'modeChosen', mode: 'source' }, { type: 'modeChosen', mode: 'notebook' }).mode
    ).toBe('notebook');
  });
});

describe('whether Run all can be pressed', () => {
  it('can, for the chat’s owner on a notebook in the checkout', () => {
    expect(runBlocker(initialNotebookView, runnable)).toBeNull();
  });

  it.each<[string, Partial<RunContext>, string]>([
    [
      'before anything is cloned',
      { fromCheckout: false },
      'Nothing is cloned yet: send a message so a chat clones the repository, then run.',
    ],
    [
      'for someone who only reads',
      { canEdit: false },
      'Only the chat’s owner runs notebooks here.',
    ],
    [
      'on a file that is not a notebook',
      { valid: false },
      'This file cannot be read as a notebook.',
    ],
    [
      'on a notebook too long to edit',
      { editable: false },
      'The notebook is too long to run from here.',
    ],
    [
      'while the checkout’s copy is in conflict with the edits',
      { conflict: true },
      'The checkout’s copy changed while you were editing; settle that first.',
    ],
    ['while the file is being saved', { saving: true }, 'The notebook is being saved.'],
    ['with no code cells', { codeCells: 0 }, 'There are no code cells to run.'],
  ])('cannot %s, and says why', (_name, change, reason) => {
    expect(runBlocker(initialNotebookView, { ...runnable, ...change })).toBe(reason);
  });

  it('cannot while a run is under way', () => {
    expect(runBlocker(after({ type: 'runStarted' }), runnable)).toBe('The notebook is running.');
  });

  it('says there is no clone before it says who may run', () => {
    expect(
      runBlocker(initialNotebookView, { ...runnable, fromCheckout: false, canEdit: false })
    ).toBe('Nothing is cloned yet: send a message so a chat clones the repository, then run.');
  });
});

describe('a run', () => {
  it('says it is running while it is', () => {
    expect(runStatus(after({ type: 'runStarted' }))).toEqual({
      tone: 'busy',
      text: 'Running every cell from the top, in the sandbox…',
    });
  });

  it('that ran every cell says how many, how long, and that nothing is committed', () => {
    const state = after({ type: 'runStarted' }, { type: 'runFinished', summary: ranAll });
    expect(state.running).toBe(false);
    expect(runStatus(state)).toEqual({
      tone: 'good',
      text: 'Ran 3 cells in 1.4 s with the built-in runner. The outputs are in the file, not committed.',
    });
    expect(failedCellIndex(state)).toBeNull();
  });

  it('of one cell is not "1 cells"', () => {
    const state = after(
      { type: 'runStarted' },
      { type: 'runFinished', summary: { ...ranAll, ran: 1, total: 1, engine: 'kernel' } }
    );
    expect(runStatus(state)?.text).toBe(
      'Ran 1 cell in 1.4 s with the checkout’s Jupyter kernel. The outputs are in the file, not committed.'
    );
  });

  it('that a cell stopped names the cell and the error, and marks the cell', () => {
    const state = after({ type: 'runStarted' }, { type: 'runFinished', summary: stoppedAtTwo });
    expect(runStatus(state)).toEqual({
      tone: 'bad',
      text: "Stopped at cell 2: KeyError: 'revenue'. 2 of 3 cells ran in 12 s.",
    });
    expect(failedCellIndex(state)).toBe(4);
  });

  it('a long one is told in minutes', () => {
    const state = after(
      { type: 'runStarted' },
      { type: 'runFinished', summary: { ...ranAll, seconds: 135 } }
    );
    expect(runStatus(state)?.text).toContain('in 2 min 15 s');
  });

  it('that was refused shows why and can be tried again', () => {
    const state = after(
      { type: 'runStarted' },
      { type: 'runRefused', error: 'There is no Python in the sandbox to run the notebook with.' }
    );
    expect(runStatus(state)).toEqual({
      tone: 'bad',
      text: 'There is no Python in the sandbox to run the notebook with.',
    });
    expect(runBlocker(state, runnable)).toBeNull();
  });

  it('that was stopped says so, and that finished cells may have kept their output', () => {
    const state = after({ type: 'runStarted' }, { type: 'runStopped' });
    expect(state.running).toBe(false);
    expect(runStatus(state)).toEqual({
      tone: 'bad',
      text: 'The run was stopped. Cells that had finished may have kept their output.',
    });
  });

  it('started again forgets what the last one said', () => {
    const state = after(
      { type: 'runStarted' },
      { type: 'runFinished', summary: stoppedAtTwo },
      { type: 'runStarted' }
    );
    expect(state.summary).toBeNull();
    expect(failedCellIndex(state)).toBeNull();
    expect(runStatus(state)?.tone).toBe('busy');
  });

  it('an answer that arrives after Stop changes nothing', () => {
    const stopped = after({ type: 'runStarted' }, { type: 'runStopped' });
    expect(notebookViewReducer(stopped, { type: 'runFinished', summary: ranAll })).toBe(stopped);
    expect(notebookViewReducer(stopped, { type: 'runRefused', error: 'late' })).toBe(stopped);
  });

  it('keeps the view the person chose', () => {
    const state = after(
      { type: 'modeChosen', mode: 'source' },
      { type: 'runStarted' },
      { type: 'runFinished', summary: ranAll }
    );
    expect(state.mode).toBe('source');
  });
});

describe('editing after a run', () => {
  it('takes down what the run said: it was about another text', () => {
    const state = after(
      { type: 'runStarted' },
      { type: 'runFinished', summary: stoppedAtTwo },
      { type: 'edited' }
    );
    expect(runStatus(state)).toBeNull();
    expect(failedCellIndex(state)).toBeNull();
  });

  it('does not hide a run that is still under way', () => {
    const state = after({ type: 'runStarted' }, { type: 'edited' });
    expect(runStatus(state)?.tone).toBe('busy');
  });
});

describe('the run route’s answer', () => {
  it('a finished run is read into its summary', () => {
    expect(
      readRunAnswer(200, {
        run: { ok: true, engine: 'kernel', ran: 2, total: 3, seconds: 4, failed: null },
      })
    ).toEqual({
      ok: true,
      summary: { engine: 'kernel', ran: 2, total: 3, seconds: 4, failed: null },
    });
  });

  it('a failed cell comes with the run', () => {
    const answer = readRunAnswer(200, {
      run: {
        engine: 'builtin',
        ran: 1,
        total: 2,
        seconds: 0.2,
        failed: { index: 3, number: 1, ename: 'ValueError', evalue: 'bad' },
      },
    });
    expect(answer).toMatchObject({
      ok: true,
      summary: { failed: { index: 3, number: 1, ename: 'ValueError', evalue: 'bad' } },
    });
  });

  it('a refusal is the route’s own sentence', () => {
    expect(
      readRunAnswer(403, { error: 'The organization is in read-only mode.', code: 'read-only' })
    ).toEqual({
      ok: false,
      error: 'The organization is in read-only mode.',
    });
  });

  it('an answer with nothing to read still says something', () => {
    expect(readRunAnswer(502, null)).toEqual({
      ok: false,
      error: 'The notebook could not be run.',
    });
    expect(readRunAnswer(200, {})).toEqual({ ok: false, error: 'The notebook could not be run.' });
  });
});
