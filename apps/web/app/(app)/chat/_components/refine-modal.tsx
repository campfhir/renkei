'use client';

/**
 * Refine, a dialog over a project's About section: the draft on the left,
 * the model's rewrite on the right (asked for the moment the dialog
 * opens), what changed under it, and a prompt at the bottom whose own
 * Try again button sits inside the field, so it is never taken for
 * Accept, which closes the footer with Cancel. The rules are
 * project-about.model.ts's; the call is the page's (project-view.tsx).
 */

import type { Dispatch } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import {
  askLabel,
  canAccept,
  canRefine,
  proposalUnchanged,
  type AboutAction,
  type AboutState,
} from './project-about.model';

const columnText =
  'h-72 overflow-auto rounded-md border p-3 font-sans text-sm whitespace-pre-wrap break-words sm:h-[50vh]';

export default function RefineModal({
  state,
  dispatch,
  onAsk,
}: {
  state: AboutState;
  dispatch: Dispatch<AboutAction>;
  onAsk: () => void;
}) {
  const { refine } = state;
  const working = refine.asking || refine.queued;
  const models = refine.models;
  const close = () => dispatch({ type: 'refineClosed' });
  const ask = () => {
    if (canRefine(state) && !working) onAsk();
  };

  return (
    <Modal title="Refine instructions" size="wide" onClose={close}>
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Original" className="min-w-0">
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">
            Original
          </h3>
          <pre
            aria-label="Original instructions"
            className={`${columnText} border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300`}
          >
            {state.fields.instructions}
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
              <span className="motion-safe:animate-pulse">Refining…</span>
            </div>
          ) : refine.proposal ? (
            <pre
              aria-label="Recommended instructions"
              className={`${columnText} border-violet-200 bg-white dark:border-violet-900 dark:bg-gray-950`}
            >
              {refine.proposal.instructions}
            </pre>
          ) : (
            <div
              className={`${columnText} flex items-center justify-center border-dashed border-gray-300 text-center text-gray-500 dark:border-gray-700`}
            >
              {refine.error ? 'No recommendation this time.' : 'Nothing yet.'}
            </div>
          )}
          {!working && refine.proposal && refine.proposal.changes.length > 0 ? (
            <div className="mt-2">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-300">What changed</p>
              <ul className="ml-4 list-disc text-xs text-gray-600 dark:text-gray-400">
                {refine.proposal.changes.map((change, index) => (
                  <li key={index}>{change}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!working && proposalUnchanged(state) ? (
            <p className="mt-2 text-xs text-gray-500">The model found nothing to change.</p>
          ) : null}
        </section>
      </div>

      <div className="mt-4">
        <label htmlFor="refine-prompt" className="mb-1 block text-xs font-medium text-gray-500">
          Anything to change? Say what, then try again.
        </label>
        <div className="flex flex-wrap items-stretch gap-2">
          <div className="flex min-w-0 flex-1 rounded-md border border-gray-300 bg-white focus-within:border-violet-500 focus-within:ring-1 focus-within:ring-violet-500 dark:border-gray-700 dark:bg-gray-900">
            <input
              id="refine-prompt"
              value={refine.guidance}
              onChange={(event) => dispatch({ type: 'guidanceTyped', text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  ask();
                }
              }}
              maxLength={2_000}
              placeholder="e.g. make it shorter, add a section on tone"
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
