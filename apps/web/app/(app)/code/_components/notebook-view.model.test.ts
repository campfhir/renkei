/**
 * A notebook in the code pane: when cells can be edited and run, the
 * order they run in, and what each answer from the kernel leaves on
 * screen.
 */

import {
  cellStatus,
  cellsToRun,
  editBlocker,
  initialNotebookView,
  installBlocker,
  installCommand,
  kernelLabel,
  notebookViewReducer,
  raisedIn,
  readKernelAnswer,
  readRunAnswer,
  runBlocker,
  structureLocked,
  type CellRun,
  type KernelInfo,
  type NotebookContext,
  type NotebookViewAction,
  type NotebookViewState,
} from './notebook-view.model';

const after = (...actions: NotebookViewAction[]) =>
  actions.reduce(notebookViewReducer, initialNotebookView);
const then = (state: NotebookViewState, ...actions: NotebookViewAction[]) =>
  actions.reduce(notebookViewReducer, state);

const mine: NotebookContext = { canEdit: true, fromCheckout: true, editable: true, valid: true };
const KERNEL: KernelInfo = { engine: 'builtin', python: '3.11.2' };

function ok(more: Partial<CellRun> = {}): CellRun {
  return {
    outputs: [],
    executionCount: 1,
    succeeded: true,
    started: false,
    timedOut: false,
    kernel: KERNEL,
    ...more,
  };
}

const raised = (ename: string, evalue: string): Partial<CellRun> => ({
  succeeded: false,
  outputs: [{ output_type: 'error', ename, evalue, traceback: [] }],
});

const finished = (index: number, more: Partial<CellRun> = {}): NotebookViewAction => ({
  type: 'cellFinished',
  index,
  run: ok(more),
});

describe('opening a notebook', () => {
  it('shows the cells, with no kernel and nothing said', () => {
    expect(initialNotebookView).toMatchObject({ mode: 'notebook', kernel: null, notice: null });
    expect(kernelLabel(initialNotebookView)).toBe('No kernel yet · starts on the first run');
  });

  it('a kernel left running from before is named', () => {
    const state = after({ type: 'kernelKnown', kernel: { engine: 'kernel', python: '3.12.1' } });
    expect(kernelLabel(state)).toBe('Python 3.12.1 · Jupyter kernel · idle');
  });

  it('Source and Notebook switch between the file and its cells', () => {
    expect(after({ type: 'modeChosen', mode: 'source' }).mode).toBe('source');
  });
});

describe('who may edit and run', () => {
  it('the chat’s owner, on a notebook in the checkout', () => {
    expect(editBlocker(mine)).toBeNull();
    expect(runBlocker(initialNotebookView, mine)).toBeNull();
  });

  it.each<[string, Partial<NotebookContext>, string]>([
    ['a file that is not a notebook', { valid: false }, 'This file cannot be read as a notebook.'],
    [
      'a notebook read before anything is cloned',
      { fromCheckout: false },
      'Nothing is cloned yet: send a message so a chat clones the repository, then edit and run.',
    ],
    [
      'someone who only reads',
      { canEdit: false },
      'Only the chat’s owner edits and runs notebooks here.',
    ],
    [
      'a notebook too long to write back',
      { editable: false },
      'The notebook is too long to edit or run from here.',
    ],
  ])('not %s, and it says why', (_name, change, reason) => {
    expect(editBlocker({ ...mine, ...change })).toBe(reason);
    expect(runBlocker(initialNotebookView, { ...mine, ...change })).toBe(reason);
  });

  it('Run all runs every code cell with something in it, top to bottom', () => {
    expect(
      cellsToRun([
        { type: 'markdown', index: 0, source: '# T' },
        { type: 'code', index: 1, source: 'a = 1' },
        { type: 'code', index: 2, source: '   \n' },
        { type: 'raw', index: 3, source: 'x' },
        { type: 'code', index: 4, source: 'a' },
      ])
    ).toEqual([1, 4]);
  });
});

describe('running one cell', () => {
  it('starts at once and shows as running', () => {
    const state = after({ type: 'runAsked', cells: [3] });
    expect(state.running).toBe(3);
    expect(cellStatus(state, 3)).toBe('running');
    expect(kernelLabel(state)).toBe('Running…');
  });

  it('finishing leaves the kernel named and nothing else said', () => {
    const state = after({ type: 'runAsked', cells: [3] }, finished(3, { started: true }));
    expect(state).toMatchObject({ running: null, kernel: KERNEL, notice: null, failed: null });
    expect(kernelLabel(state)).toBe('Python 3.11.2 · built-in kernel · idle');
    expect(cellStatus(state, 3)).toBe('idle');
  });

  it('a cell that raises is marked, with what it raised', () => {
    const state = after(
      { type: 'runAsked', cells: [3] },
      finished(3, raised('NameError', "name 'df' is not defined"))
    );
    expect(cellStatus(state, 3)).toBe('failed');
    expect(state.notice).toEqual({
      tone: 'bad',
      text: "The cell raised NameError: name 'df' is not defined.",
    });
  });

  it('running it again takes the mark and the notice down', () => {
    const state = after({ type: 'runAsked', cells: [3] }, finished(3, raised('NameError', 'x')), {
      type: 'runAsked',
      cells: [3],
    });
    expect(state).toMatchObject({ failed: null, notice: null, running: 3 });
  });

  it('an answer for a cell that is not the one running changes nothing', () => {
    const state = after({ type: 'runAsked', cells: [3] });
    expect(notebookViewReducer(state, finished(7))).toBe(state);
  });
});

describe('running several', () => {
  it('they run one at a time in the order asked, the rest waiting', () => {
    let state = after({ type: 'runAsked', cells: [1, 2, 4] });
    expect([state.running, state.queue]).toEqual([1, [2, 4]]);
    expect(cellStatus(state, 2)).toBe('queued');
    expect(kernelLabel(state)).toBe('Running · 2 waiting…');
    state = then(state, finished(1));
    expect([state.running, state.queue]).toEqual([2, [4]]);
    state = then(state, finished(2));
    expect([state.running, state.queue]).toEqual([4, []]);
  });

  it('when the last one finishes it says how many ran, and that nothing is saved', () => {
    const state = after(
      { type: 'runAsked', cells: [1, 2, 4] },
      finished(1),
      finished(2),
      finished(4)
    );
    expect(state.running).toBeNull();
    expect(state.notice).toEqual({
      tone: 'good',
      text: 'Ran 3 cells. The outputs are unsaved until you save the notebook.',
    });
  });

  it('a cell that raises stops the rest, and says how many were not run', () => {
    const state = after(
      { type: 'runAsked', cells: [1, 2, 4, 5] },
      finished(1),
      finished(2, raised('KeyError', "'revenue'"))
    );
    expect(state).toMatchObject({ running: null, queue: [], failed: 2 });
    expect(state.notice?.text).toBe(
      "The cell raised KeyError: 'revenue'. 2 cells after it were not run."
    );
  });

  it('a cell run while others are running waits its turn; one already waiting is not added twice', () => {
    const state = after(
      { type: 'runAsked', cells: [1, 2] },
      { type: 'runAsked', cells: [5] },
      { type: 'runAsked', cells: [2, 1] }
    );
    expect([state.running, state.queue]).toEqual([1, [2, 5]]);
  });

  it('a cell interrupted by its time limit says so', () => {
    const state = after(
      { type: 'runAsked', cells: [1, 2] },
      finished(1, { ...raised('KeyboardInterrupt', ''), timedOut: true })
    );
    expect(state.notice?.text).toBe(
      'The cell ran past its ten minutes and was interrupted. 1 cell after it was not run.'
    );
  });
});

describe('Stop', () => {
  it('drops the cells waiting and waits for the running one to be interrupted', () => {
    const state = after({ type: 'runAsked', cells: [1, 2, 4] }, { type: 'stopAsked' });
    expect(state).toMatchObject({ running: 1, queue: [], stopping: true });
    expect(kernelLabel(state)).toBe('Stopping…');
    expect(runBlocker(state, mine)).toBe('The running cell is being stopped.');
  });

  it('the interrupted cell is not marked as a failure: the person stopped it', () => {
    const state = after(
      { type: 'runAsked', cells: [1, 2] },
      { type: 'stopAsked' },
      finished(1, raised('KeyboardInterrupt', ''))
    );
    expect(state).toMatchObject({ running: null, stopping: false, failed: null });
    expect(state.notice).toEqual({ tone: 'info', text: 'Stopped.' });
    expect(runBlocker(state, mine)).toBeNull();
  });

  it('a cell that finished anyway just finishes; nothing more runs', () => {
    const state = after({ type: 'runAsked', cells: [1, 2] }, { type: 'stopAsked' }, finished(1));
    expect(state).toMatchObject({ running: null, queue: [], stopping: false });
  });

  it('nothing can be queued behind a cell that is being stopped', () => {
    const state = after(
      { type: 'runAsked', cells: [1] },
      { type: 'stopAsked' },
      { type: 'runAsked', cells: [2] }
    );
    expect(state.queue).toEqual([]);
  });

  it('with nothing running there is nothing to stop', () => {
    expect(notebookViewReducer(initialNotebookView, { type: 'stopAsked' })).toBe(
      initialNotebookView
    );
  });
});

describe('a kernel that was lost', () => {
  it('a run that had to start a new kernel says earlier cells’ state is gone', () => {
    const state = after(
      { type: 'kernelKnown', kernel: KERNEL },
      { type: 'runAsked', cells: [3] },
      finished(3, { started: true })
    );
    expect(state.notice).toEqual({
      tone: 'info',
      text: 'The kernel had stopped and was started again: what earlier cells defined is gone. Run them again if this cell needs them.',
    });
  });

  it('the very first run starting a kernel is nothing to remark on', () => {
    expect(
      after({ type: 'runAsked', cells: [3] }, finished(3, { started: true })).notice
    ).toBeNull();
  });

  it('a kernel that died under a cell stops the run and is no longer shown', () => {
    const state = after(
      { type: 'kernelKnown', kernel: KERNEL },
      { type: 'runAsked', cells: [1, 2] },
      {
        type: 'runRefused',
        index: 1,
        error: 'The notebook kernel ended while the cell ran.',
        kernelGone: true,
      }
    );
    expect(state).toMatchObject({ running: null, queue: [], kernel: null });
    expect(state.notice).toEqual({
      tone: 'bad',
      text: 'The notebook kernel ended while the cell ran.',
    });
  });

  it('a refusal that is not about the kernel leaves it shown', () => {
    const state = after(
      { type: 'kernelKnown', kernel: KERNEL },
      { type: 'runAsked', cells: [1] },
      {
        type: 'runRefused',
        index: 1,
        error: 'The organization is in read-only mode.',
        kernelGone: false,
      }
    );
    expect(state.kernel).toEqual(KERNEL);
  });

  it('what the page asked before a run does not overwrite what the run said', () => {
    const state = after({ type: 'runAsked', cells: [1] }, { type: 'kernelKnown', kernel: null });
    expect(state.running).toBe(1);
  });
});

describe('Restart', () => {
  const idle = after({ type: 'kernelKnown', kernel: KERNEL });

  it('ends the kernel and says nothing is defined, but packages are kept', () => {
    const state = then(idle, { type: 'restartAsked' });
    expect(kernelLabel(state)).toBe('Restarting the kernel…');
    expect(runBlocker(state, mine)).toBe('The kernel is restarting.');
    const done = then(state, { type: 'restarted' });
    expect(done).toMatchObject({ restarting: false, kernel: null });
    expect(done.notice).toEqual({
      tone: 'info',
      text: 'The kernel was restarted: nothing is defined until cells are run again. Installed packages are kept.',
    });
  });

  it('is not started while a cell runs', () => {
    const busy = then(idle, { type: 'runAsked', cells: [1] });
    expect(notebookViewReducer(busy, { type: 'restartAsked' })).toBe(busy);
  });

  it('refused, it says why and the kernel is still the kernel', () => {
    const state = then(
      idle,
      { type: 'restartAsked' },
      { type: 'restartRefused', error: 'Could not reach the server.' }
    );
    expect(state).toMatchObject({ restarting: false, kernel: KERNEL });
    expect(state.notice).toEqual({ tone: 'bad', text: 'Could not reach the server.' });
  });

  it('a run asked while it restarts does not start', () => {
    const state = then(idle, { type: 'restartAsked' }, { type: 'runAsked', cells: [1] });
    expect(state.running).toBeNull();
  });
});

describe('changing the cells', () => {
  it('cells cannot be added, moved or removed while cells run', () => {
    const busy = after({ type: 'runAsked', cells: [1, 2] });
    expect(structureLocked(busy)).toBe(true);
    expect(notebookViewReducer(busy, { type: 'cellInserted', index: 1, cell: 'code' })).toBe(busy);
    expect(notebookViewReducer(busy, { type: 'cellRemoved', index: 1 })).toBe(busy);
    expect(notebookViewReducer(busy, { type: 'cellMoved', from: 1, to: 2 })).toBe(busy);
    expect(structureLocked(then(busy, finished(1), finished(2)))).toBe(false);
  });

  it('a new text cell opens as text, ready to type; a new code cell needs no opening', () => {
    expect(after({ type: 'cellInserted', index: 2, cell: 'markdown' }).editing).toBe(2);
    expect(after({ type: 'cellInserted', index: 2, cell: 'code' }).editing).toBeNull();
  });

  it('a text cell opens on Edit and closes on Done', () => {
    const open = after({ type: 'editStarted', index: 0 });
    expect(open.editing).toBe(0);
    expect(then(open, { type: 'editEnded' }).editing).toBeNull();
  });

  it('moving or removing cells takes down the failure mark, which named a place', () => {
    const failed = after({ type: 'runAsked', cells: [3] }, finished(3, raised('E', 'x')));
    expect(then(failed, { type: 'cellRemoved', index: 0 }).failed).toBeNull();
    expect(then(failed, { type: 'cellMoved', from: 3, to: 2 }).failed).toBeNull();
    expect(then(failed, { type: 'cellInserted', index: 0, cell: 'code' }).failed).toBeNull();
  });

  it('going to Source closes an open text cell', () => {
    expect(
      after({ type: 'editStarted', index: 0 }, { type: 'modeChosen', mode: 'source' }).editing
    ).toBeNull();
  });

  it('a notice can be dismissed', () => {
    const state = after({ type: 'runAsked', cells: [1] }, finished(1, raised('E', 'x')), {
      type: 'noticeDismissed',
    });
    expect(state.notice).toBeNull();
    // The cell stays marked: the notice was only the sentence.
    expect(state.failed).toBe(1);
  });
});

describe('installing packages', () => {
  const typed = (text: string) =>
    after({ type: 'packagesToggled' }, { type: 'packagesTyped', text });

  it('what is typed becomes one pip install in the kernel', () => {
    expect(installCommand('pandas')).toBe('%pip install pandas');
    expect(installCommand('  pandas   matplotlib  ')).toBe('%pip install pandas matplotlib');
    expect(installCommand('requests==2.32 "numpy<3"')).toBeNull();
    expect(installCommand('requests==2.32 numpy<3 polars[all]')).toBe(
      '%pip install requests==2.32 numpy<3 polars[all]'
    );
    expect(installCommand('-r requirements.txt')).toBe('%pip install -r requirements.txt');
  });

  it('never more than one line, and nothing a shell or Python would read as more', () => {
    expect(installCommand('pandas\nimport os')).toBeNull();
    expect(installCommand('pandas; rm -rf ~')).toBeNull();
    expect(installCommand('$(whoami)')).toBeNull();
    expect(installCommand('`id`')).toBeNull();
    expect(installCommand("x' or '")).toBeNull();
    expect(installCommand('   ')).toBeNull();
  });

  it('Install is off until something that can be installed is named', () => {
    expect(installBlocker(typed(''))).toBe('Name the packages to install.');
    expect(installBlocker(typed('pandas; ls'))).toBe(
      'Use package names as pip takes them, such as pandas or requests==2.32.'
    );
    expect(installBlocker(typed('pandas'))).toBeNull();
  });

  it('waits for running cells, and cells wait for it', () => {
    const running = then(typed('pandas'), { type: 'runAsked', cells: [1] });
    expect(installBlocker(running)).toBe('Wait for the running cells, or stop them.');
    expect(notebookViewReducer(running, { type: 'installStarted' })).toBe(running);

    const installing = then(typed('pandas'), { type: 'installStarted' });
    expect(installing.packages.installing).toBe(true);
    expect(kernelLabel(installing)).toBe('Installing packages…');
    expect(runBlocker(installing, mine)).toBe('Packages are being installed.');
    expect(then(installing, { type: 'runAsked', cells: [1] }).running).toBeNull();
  });

  it('a finished install shows what pip said and clears the box', () => {
    const state = then(
      typed('pandas'),
      { type: 'installStarted' },
      {
        type: 'installFinished',
        run: ok({
          started: true,
          outputs: [
            {
              output_type: 'stream',
              name: 'stdout',
              text: ['Collecting pandas\n', 'Successfully installed pandas-3.0\n'],
            },
          ],
        }),
      }
    );
    expect(state.packages).toEqual({
      open: true,
      text: '',
      installing: false,
      log: 'Collecting pandas\nSuccessfully installed pandas-3.0',
      succeeded: true,
    });
    // The install started the kernel: it is there for the cells now.
    expect(state.kernel).toEqual(KERNEL);
  });

  it('a failed install shows why and keeps what was typed, to fix and try again', () => {
    const state = then(
      typed('pandsa'),
      { type: 'installStarted' },
      {
        type: 'installFinished',
        run: ok({
          succeeded: false,
          outputs: [
            {
              output_type: 'stream',
              name: 'stdout',
              text: 'ERROR: No matching distribution found for pandsa\n',
            },
            {
              output_type: 'error',
              ename: 'RuntimeError',
              evalue: 'pip exited with status 1',
              traceback: [],
            },
          ],
        }),
      }
    );
    expect(state.packages).toMatchObject({ text: 'pandsa', succeeded: false, installing: false });
    expect(state.packages.log).toBe(
      'ERROR: No matching distribution found for pandsa\nRuntimeError: pip exited with status 1'
    );
    expect(installBlocker(state)).toBeNull();
  });

  it('an install the sandbox refused says so', () => {
    const state = then(
      typed('pandas'),
      { type: 'installStarted' },
      {
        type: 'installRefused',
        error: 'Could not reach the server.',
      }
    );
    expect(state.packages).toMatchObject({
      installing: false,
      log: 'Could not reach the server.',
      succeeded: false,
    });
  });

  it('the panel does not close under an install in flight', () => {
    const installing = then(typed('pandas'), { type: 'installStarted' });
    expect(then(installing, { type: 'packagesToggled' }).packages.open).toBe(true);
  });
});

describe('reading the kernel’s answers', () => {
  it('a run', () => {
    expect(
      readRunAnswer(200, {
        run: {
          kernel: { engine: 'kernel', python: '3.12.1' },
          started: true,
          outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }],
          executionCount: 4,
          succeeded: true,
          timedOut: false,
        },
      })
    ).toEqual({
      ok: true,
      run: {
        kernel: { engine: 'kernel', python: '3.12.1' },
        started: true,
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }],
        executionCount: 4,
        succeeded: true,
        timedOut: false,
      },
    });
  });

  it('a refusal is the route’s own sentence; 410 means the kernel is gone', () => {
    expect(readRunAnswer(403, { error: 'The organization is in read-only mode.' })).toEqual({
      ok: false,
      error: 'The organization is in read-only mode.',
      kernelGone: false,
    });
    expect(readRunAnswer(410, { error: 'The notebook kernel ended.' })).toMatchObject({
      kernelGone: true,
    });
  });

  it('an answer with nothing to read still says something', () => {
    expect(readRunAnswer(502, null)).toEqual({
      ok: false,
      error: 'The cell could not be run.',
      kernelGone: false,
    });
    expect(readRunAnswer(200, { run: {} })).toMatchObject({ ok: false });
  });

  it('whether there is a kernel', () => {
    expect(readKernelAnswer({ kernel: { engine: 'builtin', python: '3.11.2' } })).toEqual(KERNEL);
    expect(readKernelAnswer({ kernel: null })).toBeNull();
    expect(readKernelAnswer(null)).toBeNull();
  });

  it('what a cell raised is its last error, on one line', () => {
    expect(
      raisedIn([
        { output_type: 'stream', name: 'stdout', text: 'x' },
        { output_type: 'error', ename: 'ValueError', evalue: 'bad value\nmore detail' },
      ])
    ).toBe('ValueError: bad value');
    expect(raisedIn([{ output_type: 'error', ename: 'KeyboardInterrupt', evalue: '' }])).toBe(
      'KeyboardInterrupt'
    );
    expect(raisedIn([{ output_type: 'stream', name: 'stdout', text: 'x' }])).toBeNull();
  });
});
