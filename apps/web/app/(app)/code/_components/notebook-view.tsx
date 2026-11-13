'use client';

/**
 * A notebook (`.ipynb`) in the code pane: its cells drawn as a notebook —
 * markdown rendered, code coloured with its execution count beside it,
 * each code cell's outputs underneath (text, tables, images, tracebacks)
 * — instead of the file's JSON, which stays one press away as Source
 * (the pane's own editor, handed in as `source`).
 *
 * Run all executes every cell on the sandbox, in the checkout
 * (`POST …/notebook/run`); the outputs land in the file itself, so the
 * pane reads it again afterwards and the tree marks it changed, to be
 * committed or discarded like any edit. Unsaved edits are saved first: a
 * run executes what is in the checkout. Stop drops the request, which
 * takes the run with it. Clear outputs is an edit like any other —
 * unsaved until Save.
 *
 * What may be pressed and what a run leaves on screen are
 * notebook-view.model.ts; reading the file is lib/code/notebook.ts.
 */

import { useMemo, useReducer, useRef, type ReactNode } from 'react';
import { highlightedTokens } from '@/components/code-tokens';
import { Icon, ICONS } from '@/components/icons';
import {
  clearNotebookOutputs,
  parseNotebook,
  type NotebookCell,
  type NotebookOutput,
} from '@/lib/code/notebook';
import { highlighterLanguageFor } from '@/lib/code/language';
import Markdown from '../../chat/_components/markdown';
import NotebookHtml from './notebook-html';
import {
  failedCellIndex,
  initialNotebookView,
  notebookViewReducer,
  readRunAnswer,
  runBlocker,
  runStatus,
} from './notebook-view.model';
import type { CodePaneFile } from './use-code-pane';

const toolbarButton =
  'flex h-7 items-center gap-1.5 rounded-md border border-gray-300 px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800';
const runButton =
  'flex h-7 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50';
const stopButton =
  'flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700';

export default function NotebookView({
  file,
  runUrl,
  canEdit,
  dirty,
  touch,
  source,
  onChange,
  onSave,
  onRan,
}: {
  file: CodePaneFile;
  /** `…/notebook/run` of the checkout the pane shows. */
  runUrl: string;
  canEdit: boolean;
  /** The file has unsaved edits; a run saves them first. */
  dirty: boolean;
  /** A touch screen: taller controls. */
  touch: boolean;
  /** The file's JSON in the pane's editor, for the Source view. */
  source: ReactNode;
  onChange: (text: string) => void;
  /** Save the file to the checkout; false when it was refused. */
  onSave: () => Promise<boolean>;
  /** A run ended and the checkout's file may have moved; `changed` when cells ran. */
  onRan: (changed: boolean) => void;
}) {
  const [state, dispatch] = useReducer(notebookViewReducer, initialNotebookView);
  const abort = useRef<AbortController | null>(null);
  const parsed = useMemo(() => parseNotebook(file.text), [file.text]);
  const notebook = parsed.ok ? parsed.notebook : null;

  const blocker = runBlocker(state, {
    canEdit,
    fromCheckout: file.source === 'checkout',
    editable: file.editable,
    valid: parsed.ok,
    codeCells: notebook?.codeCells ?? 0,
    saving: file.saving,
    conflict: file.conflict !== null,
  });
  const status = runStatus(state);
  const failedIndex = failedCellIndex(state);

  const run = async () => {
    if (blocker) return;
    dispatch({ type: 'runStarted' });
    if (dirty && !(await onSave())) {
      dispatch({
        type: 'runRefused',
        error: 'The notebook could not be saved to the checkout, so it was not run.',
      });
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    let changed = false;
    try {
      const response = await fetch(runUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      const answer = readRunAnswer(response.status, body);
      changed = answer.ok;
      dispatch(
        answer.ok
          ? { type: 'runFinished', summary: answer.summary }
          : { type: 'runRefused', error: answer.error }
      );
    } catch {
      dispatch(
        controller.signal.aborted
          ? { type: 'runStopped' }
          : { type: 'runRefused', error: 'Could not reach the server; the notebook was not run.' }
      );
    } finally {
      abort.current = null;
      // Finished, failed or stopped, the checkout's file may have moved.
      onRan(changed);
    }
  };

  const clear = () => {
    const cleared = clearNotebookOutputs(file.text);
    if (cleared === null) return;
    dispatch({ type: 'edited' });
    onChange(cleared);
  };

  const canClear = canEdit && file.editable && !state.running && (notebook?.withOutput ?? 0) > 0;
  const tall = touch ? ' h-9' : '';

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="notebook-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900">
        <div
          role="group"
          aria-label="Notebook or source"
          className="flex overflow-hidden rounded-md border border-gray-300 text-xs font-medium dark:border-gray-700"
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
        <span className="min-w-0 flex-1 basis-24 truncate text-xs text-gray-500">
          {notebook
            ? `${notebook.kernelName ?? notebook.language} · ${notebook.codeCells} code cell${notebook.codeCells === 1 ? '' : 's'}`
            : ''}
        </span>
        {canClear ? (
          <button type="button" onClick={clear} className={`${toolbarButton}${tall}`}>
            Clear outputs
          </button>
        ) : null}
        {state.running ? (
          <button
            type="button"
            onClick={() => abort.current?.abort()}
            className={`${stopButton}${tall}`}
          >
            <Icon path={ICONS.stop} className="h-3.5 w-3.5" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={blocker !== null}
            title={blocker ?? 'Run every cell from the top, in the sandbox'}
            className={`${runButton}${tall}`}
          >
            <Icon path={ICONS.play} className="h-3.5 w-3.5" />
            Run all
          </button>
        )}
      </div>
      {status ? (
        <p
          role={status.tone === 'bad' ? 'alert' : 'status'}
          data-testid="notebook-run-status"
          className={`shrink-0 border-b px-3 py-1.5 text-xs ${
            status.tone === 'bad'
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
              : status.tone === 'good'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-gray-200 bg-white text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300'
          }`}
        >
          {status.tone === 'busy' ? (
            <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
          ) : null}
          {status.text}
        </p>
      ) : null}
      {state.mode === 'source' ? (
        <div className="min-h-0 flex-1">{source}</div>
      ) : !parsed.ok ? (
        <p className="p-4 text-sm text-gray-500">
          {parsed.message} Source shows the file as it is.
        </p>
      ) : (
        <div
          className={`min-h-0 flex-1 overflow-y-auto ${state.running ? 'opacity-70' : ''}`}
          aria-busy={state.running || undefined}
        >
          <div className="mx-auto max-w-4xl space-y-3 px-3 py-4">
            {parsed.notebook.cells.length === 0 ? (
              <p className="text-sm text-gray-500">This notebook has no cells.</p>
            ) : (
              parsed.notebook.cells.map((cell) => (
                <Cell
                  key={cell.index}
                  cell={cell}
                  language={parsed.notebook.language}
                  failed={failedIndex === cell.index}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const gutter = 'w-10 shrink-0 select-none pt-2 text-right font-mono text-[11px] text-gray-400';

function Cell({
  cell,
  language,
  failed,
}: {
  cell: NotebookCell;
  language: string;
  failed: boolean;
}) {
  const grammar = highlighterLanguageFor(language);
  const tokens = useMemo(
    () => (cell.type === 'code' ? highlightedTokens(cell.source, grammar) : null),
    [cell, grammar]
  );
  if (cell.type === 'markdown') {
    return (
      <div className="flex gap-2" data-cell="markdown">
        <span className={gutter} />
        <div className="min-w-0 flex-1 text-sm">
          <Markdown text={cell.source} />
        </div>
      </div>
    );
  }
  if (cell.type === 'raw') {
    return (
      <div className="flex gap-2" data-cell="raw">
        <span className={gutter} />
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-gray-500">
          {cell.source}
        </pre>
      </div>
    );
  }
  return (
    <div data-cell="code" data-failed={failed || undefined}>
      <div className="flex gap-2">
        <span className={gutter} title={`Code cell ${cell.number}`}>
          [{cell.executionCount ?? ' '}]
        </span>
        <pre
          className={`code-tokens min-w-0 flex-1 overflow-x-auto rounded-md border bg-gray-50 px-3 py-2 font-mono text-xs leading-5 dark:bg-gray-900 ${
            failed ? 'border-red-300 dark:border-red-800' : 'border-gray-200 dark:border-gray-800'
          }`}
        >
          {tokens ?? cell.source}
        </pre>
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
