/**
 * A notebook in the code pane (notebook-view.tsx): whether the person is
 * looking at the cells or the file's JSON, a run in flight, and what the
 * last run said.
 *
 * The component makes the run's POST (and a save first, when the file
 * has unsaved edits) and dispatches what came back; whether Run may be
 * pressed and why not, what a finished or refused run leaves on screen,
 * and which cell a failure points at are here, tested in
 * notebook-view.model.test.ts. The run itself changes the file in the
 * checkout, so its outputs arrive as the file's new text, not through
 * this state.
 */

import { isRecord, isString } from '@renkei/guards';

export type NotebookViewMode = 'notebook' | 'source';

export interface RunSummary {
  engine: 'kernel' | 'builtin';
  ran: number;
  total: number;
  seconds: number;
  failed: { index: number; number: number; ename: string; evalue: string } | null;
}

export interface NotebookViewState {
  mode: NotebookViewMode;
  running: boolean;
  /** The last run that executed cells; cleared by the next run or an edit. */
  summary: RunSummary | null;
  /** Why the last run did not happen or did not finish. */
  error: string | null;
}

export type NotebookViewAction =
  | { type: 'modeChosen'; mode: NotebookViewMode }
  | { type: 'runStarted' }
  | { type: 'runFinished'; summary: RunSummary }
  | { type: 'runRefused'; error: string }
  /** The person pressed Stop; the request was dropped. */
  | { type: 'runStopped' }
  /** The file's text was edited by hand: what the last run said is about another text. */
  | { type: 'edited' };

export const initialNotebookView: NotebookViewState = {
  mode: 'notebook',
  running: false,
  summary: null,
  error: null,
};

export function notebookViewReducer(
  state: NotebookViewState,
  action: NotebookViewAction
): NotebookViewState {
  switch (action.type) {
    case 'modeChosen':
      return { ...state, mode: action.mode };
    case 'runStarted':
      return { ...state, running: true, summary: null, error: null };
    case 'runFinished':
      return state.running ? { ...state, running: false, summary: action.summary } : state;
    case 'runRefused':
      return state.running ? { ...state, running: false, error: action.error } : state;
    case 'runStopped':
      return state.running
        ? {
            ...state,
            running: false,
            error: 'The run was stopped. Cells that had finished may have kept their output.',
          }
        : state;
    case 'edited':
      return state.summary || (state.error && !state.running)
        ? { ...state, summary: null, error: null }
        : state;
  }
}

/** What the pane knows about the file, for deciding whether it can be run. */
export interface RunContext {
  /** The person may change the checkout (the chat's owner, an editor, not read-only mode). */
  canEdit: boolean;
  /** The file is read from a checkout, not from the git host before a clone. */
  fromCheckout: boolean;
  /** The file is whole and writable here (not cut short, not too long). */
  editable: boolean;
  /** The text parses as a notebook. */
  valid: boolean;
  codeCells: number;
  /** The file is being saved, or is in conflict with the checkout's copy. */
  saving: boolean;
  conflict: boolean;
}

/** Why Run cannot be pressed, as its tooltip says it; null when it can. */
export function runBlocker(state: NotebookViewState, context: RunContext): string | null {
  if (state.running) return 'The notebook is running.';
  if (!context.fromCheckout) {
    return 'Nothing is cloned yet: send a message so a chat clones the repository, then run.';
  }
  if (!context.canEdit) return 'Only the chat’s owner runs notebooks here.';
  if (!context.valid) return 'This file cannot be read as a notebook.';
  if (!context.editable) return 'The notebook is too long to run from here.';
  if (context.conflict) {
    return 'The checkout’s copy changed while you were editing; settle that first.';
  }
  if (context.saving) return 'The notebook is being saved.';
  if (context.codeCells === 0) return 'There are no code cells to run.';
  return null;
}

function seconds(value: number): string {
  if (value < 10) return `${value.toFixed(1)} s`;
  if (value < 90) return `${Math.round(value)} s`;
  return `${Math.floor(value / 60)} min ${Math.round(value % 60)} s`;
}

/** The status line under the toolbar: what the last run did, in a sentence. */
export function runStatus(
  state: NotebookViewState
): { tone: 'busy' | 'good' | 'bad'; text: string } | null {
  if (state.running) {
    return { tone: 'busy', text: 'Running every cell from the top, in the sandbox…' };
  }
  if (state.error) return { tone: 'bad', text: state.error };
  const summary = state.summary;
  if (!summary) return null;
  const engine =
    summary.engine === 'kernel' ? 'with the checkout’s Jupyter kernel' : 'with the built-in runner';
  if (summary.failed) {
    const { number, ename, evalue } = summary.failed;
    return {
      tone: 'bad',
      text: `Stopped at cell ${number}: ${ename}${evalue ? `: ${evalue}` : ''}. ${summary.ran} of ${summary.total} cells ran in ${seconds(summary.seconds)}.`,
    };
  }
  return {
    tone: 'good',
    text: `Ran ${summary.ran} cell${summary.ran === 1 ? '' : 's'} in ${seconds(summary.seconds)} ${engine}. The outputs are in the file, not committed.`,
  };
}

/** The index (in the notebook's cells) of the cell the last run stopped at. */
export function failedCellIndex(state: NotebookViewState): number | null {
  return state.summary?.failed?.index ?? null;
}

/** The run route's answer, read: a summary, or the sentence it refused with. */
export function readRunAnswer(
  status: number,
  body: unknown
): { ok: true; summary: RunSummary } | { ok: false; error: string } {
  const record = isRecord(body) ? body : {};
  if (status >= 200 && status < 300 && isRecord(record.run)) {
    const run = record.run;
    const failed = isRecord(run.failed) ? run.failed : null;
    const num = (value: unknown) => (typeof value === 'number' ? value : 0);
    return {
      ok: true,
      summary: {
        engine: run.engine === 'kernel' ? 'kernel' : 'builtin',
        ran: num(run.ran),
        total: num(run.total),
        seconds: num(run.seconds),
        failed: failed
          ? {
              index: num(failed.index),
              number: num(failed.number),
              ename: isString(failed.ename) ? failed.ename : 'Error',
              evalue: isString(failed.evalue) ? failed.evalue : '',
            }
          : null,
      },
    };
  }
  return {
    ok: false,
    error: isString(record.error) && record.error ? record.error : 'The notebook could not be run.',
  };
}
