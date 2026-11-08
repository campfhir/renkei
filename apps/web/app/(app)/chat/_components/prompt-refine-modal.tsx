'use client';

/**
 * Refine (or Draft), a dialog over a library's prompt editor: the text on
 * the left, the model's rewrite on the right with the questions it would ask
 * listed under it, and a prompt at the bottom whose own button sits inside
 * the field, so it is never taken for Accept, which closes the footer with
 * Cancel. With no text it is Draft: the left is empty and the prompt at the
 * bottom says what to write. The rules are prompt-editor.model.ts's; the call
 * is the page's (library-view.tsx).
 */

import type { Dispatch } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import {
  askLabel,
  canAccept,
  canRefine,
  drafting,
  guidanceLabel,
  promptQuestions,
  proposalUnchanged,
  refineHeading,
  titleToTake,
  type PromptEditorAction,
  type PromptEditorState,
} from './prompt-editor.model';

const columnText =
  'h-64 overflow-auto rounded-md border p-3 font-sans text-sm whitespace-pre-wrap break-words sm:h-[40vh]';

export default function PromptRefineModal({
  state,
  dispatch,
  onAsk,
}: {
  state: PromptEditorState;
  dispatch: Dispatch<PromptEditorAction>;
  onAsk: () => void;
}) {
  const { refine } = state;
  const working = refine.asking || refine.queued;
  const models = refine.models;
  const close = () => dispatch({ type: 'refineClosed' });
  const ask = () => {
    if (canRefine(state) && !working) onAsk();
  };
  const proposal = refine.proposal;
  const questions = proposal ? promptQuestions(proposal.body) : null;
  const newTitle = titleToTake(state);

  return (
    <Modal title={refineHeading(state)} size="wide" onClose={close}>
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Original" className="min-w-0">
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">
            Original
          </h3>
          <pre
            aria-label="Original prompt"
            className={`${columnText} border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300`}
          >
            {drafting(state) ? (
              <span className="text-gray-500 italic">Nothing written yet.</span>
            ) : (
              state.body
            )}
          </pre>
        </section>
        <section aria-label="Recommended" aria-busy={working} className="min-w-0">
          <h3 className="mb-1.5 flex items-center gap-1 text-xs font-semibold tracking-wide text-violet-700 uppercase dark:text-violet-400">
            <Icon path={ICONS.sparkles} className="h-3.5 w-3.5" />
            Recommended
          </h3>
          {working ? (
            <div
              className={`${columnText} flex items-center justify-center border-violet-200 text-gray-500 dark:border-violet-900`}
            >
              <span className="motion-safe:animate-pulse">
                {drafting(state) ? 'Drafting…' : 'Refining…'}
              </span>
            </div>
          ) : proposal ? (
            <pre
              aria-label="Recommended prompt"
              className={`${columnText} border-violet-200 bg-white dark:border-violet-900 dark:bg-gray-950`}
            >
              {proposal.body}
            </pre>
          ) : (
            <div
              className={`${columnText} flex items-center justify-center border-dashed border-gray-300 text-center text-gray-500 dark:border-gray-700`}
            >
              {refine.error
                ? 'No recommendation this time.'
                : drafting(state)
                  ? 'Say what the prompt is for, then draft it.'
                  : 'Nothing yet.'}
            </div>
          )}
          {!working && proposalUnchanged(state) ? (
            <p className="mt-2 text-xs text-gray-500">The model found nothing to change.</p>
          ) : null}
        </section>
      </div>

      {!working && proposal && questions ? (
        <section aria-label="Questions it asks" className="mt-4">
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">
            Questions it asks
          </h3>
          {questions.rows.length === 0 ? (
            <p className="text-sm text-gray-500">None: the prompt is inserted as written.</p>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">
              {questions.rows.map((row) => (
                <li key={row.name} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
                  <span className="font-medium">{row.label}</span>
                  <span className="text-xs text-gray-500">{row.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {questions.problems.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
              {questions.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          {newTitle ? (
            <p className="mt-2 text-xs text-gray-500">
              Suggested title: <span className="font-medium">{newTitle}</span>
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="mt-4">
        <label
          htmlFor="prompt-refine-guidance"
          className="mb-1 block text-xs font-medium text-gray-500"
        >
          {guidanceLabel(state)}
        </label>
        <div className="flex flex-wrap items-stretch gap-2">
          <div className="flex min-w-0 flex-1 rounded-md border border-gray-300 bg-white focus-within:border-violet-500 focus-within:ring-1 focus-within:ring-violet-500 dark:border-gray-700 dark:bg-gray-900">
            <input
              id="prompt-refine-guidance"
              value={refine.guidance}
              onChange={(event) => dispatch({ type: 'guidanceTyped', text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  ask();
                }
              }}
              maxLength={2_000}
              placeholder={
                drafting(state)
                  ? 'e.g. reviews a pull request and asks which files matter'
                  : 'e.g. ask which file, make it shorter'
              }
              className="min-w-0 flex-1 rounded-l-md bg-transparent px-2.5 py-1.5 text-sm outline-none"
            />
            <button
              type="button"
              onClick={ask}
              disabled={!canRefine(state) || working}
              className="m-1 flex shrink-0 items-center gap-1 rounded px-2.5 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-950"
            >
              <Icon path={ICONS.sparkles} className="h-3.5 w-3.5" />
              {askLabel(state)}
            </button>
          </div>
          {models && models.length > 1 ? (
            <select
              aria-label="Model"
              value={refine.modelId ?? ''}
              onChange={(event) => dispatch({ type: 'modelPicked', modelId: event.target.value })}
              disabled={working}
              className="max-w-[12rem] rounded-md border border-gray-300 bg-white px-2 text-xs dark:border-gray-700 dark:bg-gray-900"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {refine.error ? <p className="mt-2 text-sm text-red-600">{refine.error}</p> : null}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
        <button
          type="button"
          onClick={close}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canAccept(state)}
          onClick={() => dispatch({ type: 'proposalAccepted' })}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Accept
        </button>
      </div>
    </Modal>
  );
}
