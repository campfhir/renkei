/**
 * A notebook in the code pane (notebook-view.tsx): whether the person is
 * looking at the cells or the file's JSON; the notebook's kernel as last
 * heard of; the cells waiting to run and the one running; which cell
 * raised; a markdown cell open for editing; and the package installer.
 *
 * The component makes the calls (`…/notebook/kernel`: a cell's code out,
 * its outputs back) and changes the file's text (lib/code/notebook.ts);
 * it dispatches what the person did and what the sandbox answered. What
 * may be pressed and why not, the order cells run in, what a raised cell
 * or a lost kernel leaves on screen, and what the installer sends are
 * here, tested in notebook-view.model.test.ts.
 *
 * Cells are named by their place in the file. Cells may be typed in
 * while others run, but not added, moved or removed (`structureLocked`),
 * so a place means the same cell from the moment it is queued to the
 * moment its outputs come back.
 */

import { isRecord, isString } from '@renkei/guards';

export type NotebookViewMode = 'notebook' | 'source';

export interface KernelInfo {
  /** A real Jupyter kernel in the checkout's environment, or the sandbox's built-in runner. */
  engine: 'kernel' | 'builtin';
  python: string;
}

export interface Notice {
  tone: 'good' | 'bad' | 'info';
  text: string;
}

export interface PackagesState {
  open: boolean;
  /** What the person typed: package names as pip takes them. */
  text: string;
  installing: boolean;
  /** What pip said, when an install has run. */
  log: string | null;
  succeeded: boolean | null;
}

export interface NotebookViewState {
  mode: NotebookViewMode;
  /** The notebook's live kernel as last heard; null when it has none (or none is known). */
  kernel: KernelInfo | null;
  /** The cell in flight. */
  running: number | null;
  /** Cells waiting their turn, in order. */
  queue: number[];
  /** Cells that finished since the kernel was last idle, for the summary. */
  ran: number;
  /** Stop was pressed; the running cell is being interrupted. */
  stopping: boolean;
  /** The cell that raised and stopped the last run. */
  failed: number | null;
  notice: Notice | null;
  /** The markdown cell open as text. */
  editing: number | null;
  restarting: boolean;
  packages: PackagesState;
}

/** How one cell's run came back. */
export interface CellRun {
  outputs: unknown[];
  executionCount: number | null;
  succeeded: boolean;
  /** The kernel was started by this run: nothing earlier cells defined is there. */
  started: boolean;
  timedOut: boolean;
  kernel: KernelInfo;
}

export type NotebookViewAction =
  | { type: 'modeChosen'; mode: NotebookViewMode }
  /** The page asked whether the notebook has a kernel. */
  | { type: 'kernelKnown'; kernel: KernelInfo | null }
  /** Run these cells, in this order (one cell, or all of them). */
  | { type: 'runAsked'; cells: number[] }
  | { type: 'cellFinished'; index: number; run: CellRun }
  /** The run could not happen: the sandbox refused, or could not be reached. */
  | { type: 'runRefused'; index: number; error: string; kernelGone: boolean }
  | { type: 'stopAsked' }
  | { type: 'restartAsked' }
  | { type: 'restarted' }
  | { type: 'restartRefused'; error: string }
  | { type: 'noticeDismissed' }
  | { type: 'cellInserted'; index: number; cell: 'code' | 'markdown' }
  | { type: 'cellRemoved'; index: number }
  | { type: 'cellMoved'; from: number; to: number }
  | { type: 'editStarted'; index: number }
  | { type: 'editEnded' }
  | { type: 'packagesToggled' }
  | { type: 'packagesTyped'; text: string }
  | { type: 'installStarted' }
  | { type: 'installFinished'; run: CellRun }
  | { type: 'installRefused'; error: string };

export const initialNotebookView: NotebookViewState = {
  mode: 'notebook',
  kernel: null,
  running: null,
  queue: [],
  ran: 0,
  stopping: false,
  failed: null,
  notice: null,
  editing: null,
  restarting: false,
  packages: { open: false, text: '', installing: false, log: null, succeeded: null },
};

const LOST_KERNEL =
  'The kernel had stopped and was started again: what earlier cells defined is gone. Run them again if this cell needs them.';

/** The error a cell's outputs end in, as "NameError: name 'x' is not defined". */
export function raisedIn(outputs: unknown[]): string | null {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const output = outputs[index];
    if (isRecord(output) && output.output_type === 'error') {
      const ename = isString(output.ename) && output.ename ? output.ename : 'Error';
      const evalue = isString(output.evalue) ? output.evalue.split('\n')[0] : '';
      return evalue ? `${ename}: ${evalue}` : ename;
    }
  }
  return null;
}

/** What pip printed, from an install's outputs. */
function printedIn(outputs: unknown[]): string {
  return outputs
    .map((output) => {
      if (!isRecord(output)) return '';
      if (output.output_type === 'stream') {
        return Array.isArray(output.text)
          ? output.text.filter(isString).join('')
          : isString(output.text)
            ? output.text
            : '';
      }
      if (output.output_type === 'error') return `${raisedIn([output]) ?? ''}\n`;
      return '';
    })
    .join('')
    .trim();
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function notebookViewReducer(
  state: NotebookViewState,
  action: NotebookViewAction
): NotebookViewState {
  switch (action.type) {
    case 'modeChosen':
      return { ...state, mode: action.mode, editing: null };
    case 'kernelKnown':
      // What a run said since is newer than what the page asked before it.
      return state.running !== null ? state : { ...state, kernel: action.kernel };
    case 'runAsked': {
      const cells = action.cells.filter(
        (cell) => cell !== state.running && !state.queue.includes(cell)
      );
      if (cells.length === 0 || state.packages.installing || state.restarting) return state;
      if (state.running !== null) {
        // Under way already: these wait their turn, unless it is being stopped.
        return state.stopping ? state : { ...state, queue: [...state.queue, ...cells] };
      }
      return {
        ...state,
        running: cells[0] ?? null,
        queue: cells.slice(1),
        ran: 0,
        stopping: false,
        failed: null,
        notice: null,
      };
    }
    case 'cellFinished': {
      if (action.index !== state.running) return state;
      const { run } = action;
      const lost = run.started && state.kernel !== null;
      const ran = state.ran + 1;
      if (!run.succeeded) {
        const skipped = state.queue.length;
        const why = state.stopping
          ? 'Stopped.'
          : run.timedOut
            ? 'The cell ran past its ten minutes and was interrupted.'
            : `The cell raised ${raisedIn(run.outputs) ?? 'an error'}.`;
        return {
          ...state,
          kernel: run.kernel,
          running: null,
          queue: [],
          ran: 0,
          stopping: false,
          failed: state.stopping ? null : action.index,
          notice: {
            tone: state.stopping ? 'info' : 'bad',
            text: `${why}${skipped > 0 ? ` ${plural(skipped, 'cell')} after it ${skipped === 1 ? 'was' : 'were'} not run.` : ''}${lost ? ` ${LOST_KERNEL}` : ''}`,
          },
        };
      }
      const next = state.queue[0];
      if (next !== undefined) {
        return {
          ...state,
          kernel: run.kernel,
          running: next,
          queue: state.queue.slice(1),
          ran,
          notice: lost ? { tone: 'info', text: LOST_KERNEL } : state.notice,
        };
      }
      return {
        ...state,
        kernel: run.kernel,
        running: null,
        queue: [],
        ran: 0,
        stopping: false,
        notice: lost
          ? { tone: 'info', text: LOST_KERNEL }
          : ran > 1
            ? {
                tone: 'good',
                text: `Ran ${plural(ran, 'cell')}. The outputs are unsaved until you save the notebook.`,
              }
            : state.notice,
      };
    }
    case 'runRefused':
      if (action.index !== state.running) return state;
      return {
        ...state,
        kernel: action.kernelGone ? null : state.kernel,
        running: null,
        queue: [],
        ran: 0,
        stopping: false,
        notice: { tone: 'bad', text: action.error },
      };
    case 'stopAsked':
      return state.running === null ? state : { ...state, stopping: true, queue: [] };
    case 'restartAsked':
      return state.running !== null || state.packages.installing
        ? state
        : { ...state, restarting: true, notice: null };
    case 'restarted':
      return {
        ...state,
        restarting: false,
        kernel: null,
        failed: null,
        notice: {
          tone: 'info',
          text: 'The kernel was restarted: nothing is defined until cells are run again. Installed packages are kept.',
        },
      };
    case 'restartRefused':
      return { ...state, restarting: false, notice: { tone: 'bad', text: action.error } };
    case 'noticeDismissed':
      return { ...state, notice: null };
    case 'cellInserted':
      if (structureLocked(state)) return state;
      return {
        ...state,
        failed: null,
        // New text opens ready to type; a code cell is always ready.
        editing: action.cell === 'markdown' ? action.index : null,
      };
    case 'cellRemoved':
    case 'cellMoved':
      return structureLocked(state) ? state : { ...state, failed: null, editing: null };
    case 'editStarted':
      return { ...state, editing: action.index };
    case 'editEnded':
      return { ...state, editing: null };
    case 'packagesToggled':
      return state.packages.installing
        ? state
        : { ...state, packages: { ...state.packages, open: !state.packages.open } };
    case 'packagesTyped':
      return { ...state, packages: { ...state.packages, text: action.text } };
    case 'installStarted':
      return state.running !== null || installCommand(state.packages.text) === null
        ? state
        : {
            ...state,
            packages: { ...state.packages, installing: true, log: null, succeeded: null },
          };
    case 'installFinished':
      if (!state.packages.installing) return state;
      return {
        ...state,
        kernel: action.run.kernel,
        packages: {
          ...state.packages,
          installing: false,
          text: action.run.succeeded ? '' : state.packages.text,
          log: printedIn(action.run.outputs) || null,
          succeeded: action.run.succeeded,
        },
      };
    case 'installRefused':
      return {
        ...state,
        packages: { ...state.packages, installing: false, log: action.error, succeeded: false },
      };
  }
}

/** Cells are running or waiting: cells may not be added, moved or removed meanwhile. */
export function structureLocked(state: NotebookViewState): boolean {
  return state.running !== null || state.queue.length > 0;
}

/** How a cell stands in the run: what its gutter shows. */
export function cellStatus(
  state: NotebookViewState,
  index: number
): 'running' | 'queued' | 'failed' | 'idle' {
  if (state.running === index) return 'running';
  if (state.queue.includes(index)) return 'queued';
  if (state.failed === index) return 'failed';
  return 'idle';
}

/** What the pane knows about the file, for deciding what can be done to it. */
export interface NotebookContext {
  /** The person may change the checkout (the chat's owner, an editor, not read-only mode). */
  canEdit: boolean;
  /** The file is read from a checkout, not from the git host before a clone. */
  fromCheckout: boolean;
  /** The file is whole and writable here (not cut short, not too long). */
  editable: boolean;
  /** The text parses as a notebook. */
  valid: boolean;
}

/** Why the cells cannot be edited in place, or null when they can. */
export function editBlocker(context: NotebookContext): string | null {
  if (!context.valid) return 'This file cannot be read as a notebook.';
  if (!context.fromCheckout) {
    return 'Nothing is cloned yet: send a message so a chat clones the repository, then edit and run.';
  }
  if (!context.canEdit) return 'Only the chat’s owner edits and runs notebooks here.';
  if (!context.editable) return 'The notebook is too long to edit or run from here.';
  return null;
}

/** Why cells cannot be run, as the button's tooltip says it; null when they can. */
export function runBlocker(state: NotebookViewState, context: NotebookContext): string | null {
  const edit = editBlocker(context);
  if (edit) return edit;
  if (state.restarting) return 'The kernel is restarting.';
  if (state.packages.installing) return 'Packages are being installed.';
  if (state.stopping) return 'The running cell is being stopped.';
  return null;
}

/** The cells Run all runs: every code cell with something in it, top to bottom. */
export function cellsToRun(
  cells: readonly { type: string; index: number; source: string }[]
): number[] {
  return cells
    .filter((cell) => cell.type === 'code' && cell.source.trim() !== '')
    .map((cell) => cell.index);
}

/** The kernel, in the toolbar's words. */
export function kernelLabel(state: NotebookViewState): string {
  if (state.restarting) return 'Restarting the kernel…';
  if (state.running !== null) {
    const waiting = state.queue.length;
    return state.stopping ? 'Stopping…' : `Running${waiting > 0 ? ` · ${waiting} waiting` : ''}…`;
  }
  if (state.packages.installing) return 'Installing packages…';
  if (!state.kernel) return 'No kernel yet · starts on the first run';
  const python = state.kernel.python ? `Python ${state.kernel.python}` : 'Python';
  return `${python} · ${state.kernel.engine === 'kernel' ? 'Jupyter kernel' : 'built-in kernel'} · idle`;
}

/** Names, versions and the few flags pip takes — on one line, so it can only ever be one command. */
const PACKAGE_SPEC = /^[A-Za-z0-9_.\-[\],<>=!~@:/+ ]+$/;

/** The cell the installer runs for what was typed, or null when there is nothing (or nothing safe) to run. */
export function installCommand(text: string): string | null {
  const typed = text.trim();
  // A line break is refused, not folded away: what was typed is one command or nothing.
  if (/[\r\n]/.test(typed)) return null;
  const spec = typed.replace(/\s+/g, ' ');
  if (!spec || !PACKAGE_SPEC.test(spec)) return null;
  return `%pip install ${spec}`;
}

/** Why Install cannot be pressed, or null when it can. */
export function installBlocker(state: NotebookViewState): string | null {
  if (state.packages.installing) return 'Installing…';
  if (state.running !== null) return 'Wait for the running cells, or stop them.';
  if (!state.packages.text.trim()) return 'Name the packages to install.';
  if (installCommand(state.packages.text) === null) {
    return 'Use package names as pip takes them, such as pandas or requests==2.32.';
  }
  return null;
}

/** The kernel route's answer to a cell, read: a run, or the sentence it was refused with. */
export function readRunAnswer(
  status: number,
  body: unknown
): { ok: true; run: CellRun } | { ok: false; error: string; kernelGone: boolean } {
  const record = isRecord(body) ? body : {};
  const run = isRecord(record.run) ? record.run : null;
  const kernel = run && isRecord(run.kernel) ? run.kernel : null;
  if (status >= 200 && status < 300 && run && kernel && Array.isArray(run.outputs)) {
    return {
      ok: true,
      run: {
        outputs: run.outputs,
        executionCount: typeof run.executionCount === 'number' ? run.executionCount : null,
        succeeded: run.succeeded === true,
        started: run.started === true,
        timedOut: run.timedOut === true,
        kernel: {
          engine: kernel.engine === 'kernel' ? 'kernel' : 'builtin',
          python: isString(kernel.python) ? kernel.python : '',
        },
      },
    };
  }
  return {
    ok: false,
    error: isString(record.error) && record.error ? record.error : 'The cell could not be run.',
    // 410: the kernel ended under the cell.
    kernelGone: status === 410,
  };
}

/** The kernel route's answer to "is there a kernel", read. */
export function readKernelAnswer(body: unknown): KernelInfo | null {
  const kernel = isRecord(body) && isRecord(body.kernel) ? body.kernel : null;
  if (!kernel) return null;
  return {
    engine: kernel.engine === 'kernel' ? 'kernel' : 'builtin',
    python: isString(kernel.python) ? kernel.python : '',
  };
}
