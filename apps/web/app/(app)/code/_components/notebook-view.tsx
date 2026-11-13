'use client';

/**
 * A notebook (`.ipynb`) in the code pane, worked in as a notebook: its
 * cells drawn in place of the file's JSON — markdown rendered, code
 * coloured with its execution count beside it, each code cell's outputs
 * underneath (text, tables, images, tracebacks) — and edited where they
 * are. A code cell is always a text box; a text cell opens as one on a
 * double click. Cells are added between any two, moved and removed. The
 * JSON stays one press away as Source (the pane's own editor, handed in
 * as `source`).
 *
 * Cells run one at a time in the notebook's kernel, a Python the sandbox
 * keeps for this notebook (`…/notebook/kernel`): ▶ or Shift+Enter runs a
 * cell with what the earlier ones defined still there, Run all runs
 * them top to bottom, Stop interrupts the running cell and drops the
 * rest, Restart ends the kernel so the next run starts clean. Packages
 * installs with pip into the kernel's environment. A run sends the
 * cell's text as it stands — saved or not — and its outputs come back
 * into the notebook as an edit: everything here is unsaved until the
 * pane's Save, and uncommitted until a commit, like any other file.
 *
 * What may be pressed, the order cells run in and what each answer
 * leaves on screen are notebook-view.model.ts; reading and changing the
 * file's text is lib/code/notebook.ts.
 */

import { useEffect, useMemo, useReducer, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { highlightedTokens } from '@/components/code-tokens';
import { Icon, ICONS } from '@/components/icons';
import {
  cellSource,
  clearNotebookOutputs,
  deleteCell,
  insertCell,
  moveCell,
  parseNotebook,
  setCellRun,
  setCellSource,
  type NotebookCell,
  type NotebookOutput,
} from '@/lib/code/notebook';
import { highlighterLanguageFor } from '@/lib/code/language';
import Markdown from '../../chat/_components/markdown';
import NotebookHtml from './notebook-html';
import {
  cellStatus,
  cellsToRun,
  editBlocker,
  initialNotebookView,
  installBlocker,
  installCommand,
  kernelLabel,
  notebookViewReducer,
  readKernelAnswer,
  readRunAnswer,
  runBlocker,
  structureLocked,
} from './notebook-view.model';
import type { CodePaneFile } from './use-code-pane';

const toolbarButton =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-gray-300 px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800';
const runButton =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50';
const stopButton =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60';
const cellButton =
  'flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800 disabled:opacity-40 dark:hover:bg-gray-700 dark:hover:text-gray-100';

/** The text metrics the code box and the colouring under it must share to the pixel. */
const codeText =
  'm-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] [tab-size:4]';

export default function NotebookView({
  file,
  kernelUrl,
  canEdit,
  touch,
  source,
  onChange,
  onSave,
}: {
  file: CodePaneFile;
  /** `…/notebook/kernel` of the checkout the pane shows. */
  kernelUrl: string;
  canEdit: boolean;
  /** A touch screen: taller controls, cell actions always showing. */
  touch: boolean;
  /** The file's JSON in the pane's editor, for the Source view. */
  source: ReactNode;
  onChange: (text: string) => void;
  /** Save the file to the checkout (⌘S in a cell). */
  onSave: () => void;
}) {
  const [state, dispatch] = useReducer(notebookViewReducer, initialNotebookView);
  const parsed = useMemo(() => parseNotebook(file.text), [file.text]);
  const notebook = parsed.ok ? parsed.notebook : null;
  // The file's text as of the latest render: a cell's outputs come back
  // long after the render that sent it, into whatever the text is by then.
  const text = useRef(file.text);
  text.current = file.text;
  const change = useRef(onChange);
  change.current = onChange;
  const cellRefs = useRef(new Map<number, HTMLTextAreaElement>());

  const context = {
    canEdit,
    fromCheckout: file.source === 'checkout',
    editable: file.editable,
    valid: parsed.ok,
  };
  const readOnly = editBlocker(context) !== null;
  const blocked = runBlocker(state, context);
  const locked = structureLocked(state);
  const fromCheckout = file.source === 'checkout';
  const path = file.path;

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(kernelUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, ...body }),
    });
    const answer: unknown = await response.json().catch(() => null);
    return { status: response.status, body: answer };
  };

  // Whether the notebook already has a kernel (a reload, another tab).
  useEffect(() => {
    if (!fromCheckout) return;
    let gone = false;
    void fetch(`${kernelUrl}?path=${encodeURIComponent(path)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!gone) dispatch({ type: 'kernelKnown', kernel: readKernelAnswer(body) });
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [kernelUrl, path, fromCheckout]);

  // The model says which cell runs; this sends it and brings its outputs back.
  const inFlight = useRef<number | null>(null);
  const running = state.running;
  useEffect(() => {
    if (running === null || inFlight.current === running) return;
    inFlight.current = running;
    const index = running;
    const code = cellSource(text.current, index) ?? '';
    // As Jupyter does: the old output goes when the cell starts.
    const cleared = setCellRun(text.current, index, [], null);
    if (cleared !== null) change.current(cleared);
    void post({ action: 'execute', code })
      .then(({ status, body }) => readRunAnswer(status, body))
      .catch(() => ({
        ok: false as const,
        error: 'Could not reach the server; the cell was not run.',
        kernelGone: false,
      }))
      .then((answer) => {
        inFlight.current = null;
        if (!answer.ok) {
          dispatch({
            type: 'runRefused',
            index,
            error: answer.error,
            kernelGone: answer.kernelGone,
          });
          return;
        }
        const next = setCellRun(text.current, index, answer.run.outputs, answer.run.executionCount);
        if (next !== null) change.current(next);
        dispatch({ type: 'cellFinished', index, run: answer.run });
      });
    // `post` reads only the path and the URL, both fixed for this mount.
  }, [running]);

  const run = (cells: number[]) => {
    if (blocked || cells.length === 0) return;
    dispatch({ type: 'runAsked', cells });
  };
  const stop = () => {
    dispatch({ type: 'stopAsked' });
    void post({ action: 'interrupt' }).catch(() => undefined);
  };
  const restart = async () => {
    dispatch({ type: 'restartAsked' });
    try {
      const { status, body } = await post({ action: 'restart' });
      if (status >= 200 && status < 300) dispatch({ type: 'restarted' });
      else {
        const answer = readRunAnswer(status, body);
        dispatch({
          type: 'restartRefused',
          error: answer.ok ? 'The kernel could not be restarted.' : answer.error,
        });
      }
    } catch {
      dispatch({ type: 'restartRefused', error: 'Could not reach the server.' });
    }
  };
  const install = async () => {
    const code = installCommand(state.packages.text);
    if (code === null || installBlocker(state) !== null) return;
    dispatch({ type: 'installStarted' });
    try {
      const { status, body } = await post({ action: 'execute', code });
      const answer = readRunAnswer(status, body);
      dispatch(
        answer.ok
          ? { type: 'installFinished', run: answer.run }
          : { type: 'installRefused', error: answer.error }
      );
    } catch {
      dispatch({ type: 'installRefused', error: 'Could not reach the server.' });
    }
  };

  /** Apply a change to the file's text, when it took. */
  const edit = (next: string | null): boolean => {
    if (next === null) return false;
    onChange(next);
    return true;
  };
  const add = (after: number, cell: 'code' | 'markdown') => {
    if (locked) return;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    if (edit(insertCell(text.current, after, cell, id))) {
      dispatch({ type: 'cellInserted', index: after + 1, cell });
      if (cell === 'code') {
        // The new cell exists after the next paint; put the caret in it.
        requestAnimationFrame(() => cellRefs.current.get(after + 1)?.focus());
      }
    }
  };
  const remove = (index: number) => {
    if (locked) return;
    if (edit(deleteCell(text.current, index))) dispatch({ type: 'cellRemoved', index });
  };
  const move = (index: number, by: -1 | 1) => {
    if (locked) return;
    if (edit(moveCell(text.current, index, by))) {
      dispatch({ type: 'cellMoved', from: index, to: index + by });
    }
  };
  const clear = () => {
    edit(clearNotebookOutputs(text.current));
  };

  const tall = touch ? ' h-9' : '';
  const busy = state.running !== null;
  const count = notebook?.cells.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="notebook-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900">
        <div
          role="group"
          aria-label="Notebook or source"
          className="flex shrink-0 overflow-hidden rounded-md border border-gray-300 text-xs font-medium dark:border-gray-700"
        >
          {(['notebook', 'source'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={state.mode === mode}
              onClick={() => dispatch({ type: 'modeChosen', mode })}
              className={`h-7 px-2.5${tall} ${
                state.mode === mode
                  ? 'bg-white text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {mode === 'notebook' ? 'Notebook' : 'Source'}
            </button>
          ))}
        </div>
        <span
          role="status"
          data-testid="notebook-kernel"
          title={fromCheckout ? kernelLabel(state) : undefined}
          className="flex min-w-0 flex-1 basis-0 items-center gap-1.5 truncate text-xs text-gray-500"
        >
          {fromCheckout ? (
            <>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  busy || state.packages.installing || state.restarting
                    ? 'bg-amber-500 motion-safe:animate-pulse'
                    : state.kernel
                      ? 'bg-emerald-500'
                      : 'bg-gray-300 dark:bg-gray-600'
                }`}
              />
              <span className="truncate">{kernelLabel(state)}</span>
            </>
          ) : (
            <span className="truncate">{notebook?.kernelName ?? notebook?.language ?? ''}</span>
          )}
        </span>
        {!readOnly ? (
          <>
            <button
              type="button"
              onClick={() => dispatch({ type: 'packagesToggled' })}
              aria-expanded={state.packages.open}
              className={`${toolbarButton}${tall}`}
            >
              <Icon path={ICONS.package} className="h-3.5 w-3.5" />
              Packages
            </button>
            <button
              type="button"
              onClick={() => void restart()}
              disabled={busy || state.restarting || state.packages.installing || !state.kernel}
              title={
                state.kernel
                  ? 'End the kernel; the next run starts with nothing defined'
                  : 'There is no kernel to restart yet.'
              }
              className={`${toolbarButton}${tall}`}
            >
              Restart
            </button>
            {(notebook?.withOutput ?? 0) > 0 && !busy ? (
              <button
                type="button"
                onClick={clear}
                aria-label="Clear outputs"
                title="Take every cell’s output out of the notebook"
                className={`${toolbarButton}${tall}`}
              >
                Clear
              </button>
            ) : null}
          </>
        ) : null}
        {busy ? (
          <button
            type="button"
            onClick={stop}
            disabled={state.stopping}
            title="Interrupt the running cell and drop the ones waiting"
            className={`${stopButton}${tall}`}
          >
            <Icon path={ICONS.stop} className="h-3.5 w-3.5" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => run(cellsToRun(notebook?.cells ?? []))}
            disabled={blocked !== null || cellsToRun(notebook?.cells ?? []).length === 0}
            title={blocked ?? 'Run every cell from the top, in the notebook’s kernel'}
            className={`${runButton}${tall}`}
          >
            <Icon path={ICONS.play} className="h-3.5 w-3.5" />
            Run all
          </button>
        )}
      </div>
      {state.packages.open && !readOnly ? (
        <form
          aria-label="Install packages"
          onSubmit={(event) => {
            event.preventDefault();
            void install();
          }}
          className="shrink-0 space-y-1.5 border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-950"
        >
          <div className="flex gap-2">
            <input
              aria-label="Packages to install"
              value={state.packages.text}
              onChange={(event) => dispatch({ type: 'packagesTyped', text: event.target.value })}
              placeholder="pandas matplotlib requests==2.32"
              disabled={state.packages.installing}
              spellCheck={false}
              autoCapitalize="none"
              className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
            />
            <button
              type="submit"
              disabled={installBlocker(state) !== null}
              title={installBlocker(state) ?? 'pip install into the notebook’s environment'}
              className={`${toolbarButton} h-8`}
            >
              {state.packages.installing ? 'Installing…' : 'Install'}
            </button>
          </div>
          <p className="text-[11px] text-gray-500">
            Installed with pip into the Python this notebook runs on, in the sandbox, and kept there
            for later runs. A cell can do the same with <code>%pip install …</code>.
          </p>
          {state.packages.log !== null ? (
            <pre
              role={state.packages.succeeded ? 'status' : 'alert'}
              data-testid="notebook-install-log"
              className={`max-h-40 overflow-auto whitespace-pre-wrap rounded border px-2 py-1 font-mono text-[11px] leading-4 ${
                state.packages.succeeded
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
              }`}
            >
              {state.packages.log}
            </pre>
          ) : null}
        </form>
      ) : null}
      {state.notice ? (
        <p
          role={state.notice.tone === 'bad' ? 'alert' : 'status'}
          data-testid="notebook-run-status"
          className={`flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-xs ${
            state.notice.tone === 'bad'
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
              : state.notice.tone === 'good'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200'
          }`}
        >
          <span className="flex-1">{state.notice.text}</span>
          <button
            type="button"
            onClick={() => dispatch({ type: 'noticeDismissed' })}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <Icon path={ICONS.close} className="h-3 w-3" />
          </button>
        </p>
      ) : null}
      {state.mode === 'source' ? (
        <div className="min-h-0 flex-1">{source}</div>
      ) : !parsed.ok ? (
        <p className="p-4 text-sm text-gray-500">
          {parsed.message} Source shows the file as it is.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-3 py-4">
            {readOnly && fromCheckout === false ? (
              <p className="mb-3 text-xs text-gray-500">{editBlocker(context)}</p>
            ) : null}
            {count === 0 ? (
              <p className="mb-2 text-sm text-gray-500">
                This notebook has no cells yet.{readOnly ? '' : ' Add the first one.'}
              </p>
            ) : null}
            {!readOnly ? <AddRow at={-1} onAdd={add} locked={locked} always={count === 0} /> : null}
            {parsed.notebook.cells.map((cell, position) => (
              <div key={cell.index}>
                <Cell
                  cell={cell}
                  language={parsed.notebook.language}
                  status={cellStatus(state, cell.index)}
                  readOnly={readOnly}
                  locked={locked}
                  touch={touch}
                  first={position === 0}
                  last={position === count - 1}
                  editing={state.editing === cell.index}
                  runBlocked={blocked}
                  register={(element) => {
                    if (element) cellRefs.current.set(cell.index, element);
                    else cellRefs.current.delete(cell.index);
                  }}
                  onSource={(value) => edit(setCellSource(text.current, cell.index, value))}
                  onRun={() => run([cell.index])}
                  onSave={onSave}
                  onMove={(by) => move(cell.index, by)}
                  onRemove={() => remove(cell.index)}
                  onEdit={(open) =>
                    dispatch(
                      open ? { type: 'editStarted', index: cell.index } : { type: 'editEnded' }
                    )
                  }
                />
                {!readOnly ? (
                  <AddRow
                    at={cell.index}
                    onAdd={add}
                    locked={locked}
                    always={touch || position === count - 1}
                  />
                ) : (
                  <div className="h-3" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The thin row between two cells where a new one goes. */
function AddRow({
  at,
  onAdd,
  locked,
  always,
}: {
  /** The cell the new one follows; -1 for the top. */
  at: number;
  onAdd: (after: number, cell: 'code' | 'markdown') => void;
  locked: boolean;
  /** Shown without hovering: the end of the notebook, a touch screen. */
  always: boolean;
}) {
  const button =
    'flex h-5 items-center gap-1 rounded border border-gray-300 bg-white px-1.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800';
  return (
    <div
      className={`flex h-6 items-center justify-center gap-2 ${
        always ? '' : 'opacity-0 focus-within:opacity-100 hover:opacity-100'
      }`}
      title={locked ? 'Cells cannot be added while cells are running.' : undefined}
    >
      <button
        type="button"
        disabled={locked}
        onClick={() => onAdd(at, 'code')}
        aria-label={at < 0 ? 'Add a code cell at the top' : 'Add a code cell here'}
        className={button}
      >
        <Icon path={ICONS.plus} className="h-3 w-3" />
        Code
      </button>
      <button
        type="button"
        disabled={locked}
        onClick={() => onAdd(at, 'markdown')}
        aria-label={at < 0 ? 'Add a text cell at the top' : 'Add a text cell here'}
        className={button}
      >
        <Icon path={ICONS.plus} className="h-3 w-3" />
        Text
      </button>
    </div>
  );
}

const gutter = 'w-10 shrink-0 select-none pt-2 text-right font-mono text-[11px] text-gray-400';

function Cell({
  cell,
  language,
  status,
  readOnly,
  locked,
  touch,
  first,
  last,
  editing,
  runBlocked,
  register,
  onSource,
  onRun,
  onSave,
  onMove,
  onRemove,
  onEdit,
}: {
  cell: NotebookCell;
  language: string;
  status: 'running' | 'queued' | 'failed' | 'idle';
  readOnly: boolean;
  /** Cells are running: no moving or removing. */
  locked: boolean;
  touch: boolean;
  first: boolean;
  last: boolean;
  /** A text cell open as text. */
  editing: boolean;
  runBlocked: string | null;
  register: (element: HTMLTextAreaElement | null) => void;
  onSource: (value: string) => void;
  onRun: () => void;
  onSave: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onEdit: (open: boolean) => void;
}) {
  const grammar = highlighterLanguageFor(language);
  const tokens = useMemo(
    () => (cell.type === 'code' ? highlightedTokens(cell.source, grammar) : null),
    [cell, grammar]
  );
  const label = cell.type === 'code' ? `code cell ${cell.number}` : 'text cell';

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const command = event.metaKey || event.ctrlKey;
    if (event.key === 'Enter' && (event.shiftKey || command)) {
      event.preventDefault();
      if (cell.type === 'code') onRun();
      else onEdit(false);
    } else if (event.key === 's' && command) {
      event.preventDefault();
      onSave();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (cell.type === 'code') event.currentTarget.blur();
      else onEdit(false);
    } else if (event.key === 'Tab' && !event.shiftKey && cell.type === 'code') {
      // Code is indented with Tab; Escape lets the keyboard leave the cell.
      event.preventDefault();
      const box = event.currentTarget;
      box.setRangeText('    ', box.selectionStart, box.selectionEnd, 'end');
      onSource(box.value);
    }
  };

  const actions = readOnly ? null : (
    <div
      className={`flex items-center gap-0.5 ${
        touch
          ? // No hover on a touch screen: the actions sit above the cell, always there.
            'mb-0.5 justify-end'
          : 'absolute right-1 top-1 z-10 rounded-md border border-gray-200 bg-white/95 p-0.5 opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 dark:border-gray-700 dark:bg-gray-900/95'
      }`}
    >
      {cell.type === 'code' ? (
        <button
          type="button"
          onClick={onRun}
          disabled={
            runBlocked !== null ||
            status === 'running' ||
            status === 'queued' ||
            !cell.source.trim()
          }
          aria-label={`Run ${label}`}
          title={runBlocked ?? 'Run this cell (Shift+Enter)'}
          className={`${cellButton} text-emerald-700 dark:text-emerald-400`}
        >
          <Icon path={ICONS.play} className="h-3.5 w-3.5" />
        </button>
      ) : cell.type === 'markdown' ? (
        <button
          type="button"
          onClick={() => onEdit(!editing)}
          aria-label={editing ? `Finish editing ${label}` : `Edit ${label}`}
          title={editing ? 'Done (Shift+Enter)' : 'Edit (double-click)'}
          className={cellButton}
        >
          <Icon path={editing ? ICONS.check : ICONS.pencil} className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={locked || first}
        aria-label={`Move ${label} up`}
        title="Move up"
        className={cellButton}
      >
        <Icon path={ICONS.chevron} className="h-3.5 w-3.5 -rotate-90" />
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={locked || last}
        aria-label={`Move ${label} down`}
        title="Move down"
        className={cellButton}
      >
        <Icon path={ICONS.chevron} className="h-3.5 w-3.5 rotate-90" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={locked}
        aria-label={`Delete ${label}`}
        title="Delete this cell"
        className={`${cellButton} hover:text-red-600 dark:hover:text-red-400`}
      >
        <Icon path={ICONS.trash} className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  if (cell.type === 'markdown') {
    return (
      <div className="group relative flex gap-2" data-cell="markdown">
        <span className={gutter} />
        <div className="min-w-0 flex-1">
          {actions}
          {editing && !readOnly ? (
            <textarea
              aria-label={`Text of ${label}`}
              value={cell.source}
              onChange={(event) => onSource(event.target.value)}
              onKeyDown={keys}
              autoFocus
              rows={Math.max(3, cell.source.split('\n').length + 1)}
              placeholder="Markdown"
              spellCheck
              className="block w-full resize-y rounded-md border border-blue-300 bg-white px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-blue-500 dark:border-blue-800 dark:bg-gray-950"
            />
          ) : (
            <div
              className={`min-h-6 rounded-md px-1 text-sm ${readOnly ? '' : 'cursor-text hover:bg-gray-50 dark:hover:bg-gray-900'}`}
              onDoubleClick={readOnly ? undefined : () => onEdit(true)}
            >
              {cell.source.trim() ? (
                <Markdown text={cell.source} />
              ) : (
                <p className="py-1 text-xs italic text-gray-400">
                  Empty text cell{readOnly ? '' : ' — double-click to write'}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (cell.type === 'raw') {
    return (
      <div className="group relative flex gap-2" data-cell="raw">
        <span className={gutter} />
        <div className="min-w-0 flex-1">
          {actions}
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-gray-500">
            {cell.source}
          </pre>
        </div>
      </div>
    );
  }
  const active = status === 'running' || status === 'queued';
  return (
    <div data-cell="code" data-status={status}>
      <div className="group relative flex gap-2">
        <span
          className={`${gutter} ${active ? 'text-amber-600 dark:text-amber-400' : ''}`}
          title={
            status === 'running'
              ? 'Running'
              : status === 'queued'
                ? 'Waiting its turn'
                : `Code cell ${cell.number}`
          }
        >
          [{active ? '*' : (cell.executionCount ?? ' ')}]
        </span>
        <div className="min-w-0 flex-1">
          {touch ? actions : null}
          <div
            className={`code-tokens relative rounded-md border bg-gray-50 dark:bg-gray-900 ${
              status === 'failed'
                ? 'border-red-300 dark:border-red-800'
                : status === 'running'
                  ? 'border-amber-400 dark:border-amber-600'
                  : 'border-gray-200 focus-within:border-blue-400 dark:border-gray-800 dark:focus-within:border-blue-600'
            }`}
          >
            {touch ? null : actions}
            {/* The colours: the same text, drawn under the box that is typed in. */}
            <pre aria-hidden={!readOnly || undefined} className={`${codeText} min-h-9`}>
              {tokens ?? cell.source}
              {'\n'}
            </pre>
            {readOnly ? null : (
              <textarea
                ref={register}
                aria-label={`Code of cell ${cell.number}`}
                value={cell.source}
                onChange={(event) => onSource(event.target.value)}
                onKeyDown={keys}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                className={`${codeText} absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-gray-900 outline-none selection:bg-blue-200/60 dark:caret-gray-100 dark:selection:bg-blue-500/40`}
              />
            )}
          </div>
        </div>
      </div>
      {cell.outputs.length > 0 ? (
        <div className="mt-1 flex gap-2" data-testid="cell-outputs">
          <span className={gutter} />
          <div className="min-w-0 flex-1 space-y-1.5">
            {cell.outputs.map((output, index) => (
              <Output key={index} output={output} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const outputText =
  'overflow-x-auto whitespace-pre-wrap break-words px-1 font-mono text-xs leading-5';

function Output({ output }: { output: NotebookOutput }) {
  switch (output.kind) {
    case 'stream':
      return (
        <pre
          className={`${outputText} ${
            output.name === 'stderr'
              ? 'rounded bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
              : 'text-gray-800 dark:text-gray-200'
          }`}
        >
          {output.text}
        </pre>
      );
    case 'text':
      return <pre className={`${outputText} text-gray-800 dark:text-gray-200`}>{output.text}</pre>;
    case 'markdown':
      return (
        <div className="px-1 text-sm">
          <Markdown text={output.text} />
        </div>
      );
    case 'html':
      return <NotebookHtml html={output.html} />;
    case 'image':
      return (
        // A data URI from the notebook itself: nothing for an image optimiser to do.
        <img
          src={output.src}
          alt="Cell output"
          className="max-w-full rounded bg-white"
          data-testid="cell-image"
        />
      );
    case 'error':
      return (
        <pre
          role="alert"
          className={`${outputText} rounded border border-red-200 bg-red-50 py-1.5 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200`}
        >
          {output.traceback}
        </pre>
      );
  }
}
