'use client';

/**
 * Refine, under a project's instructions field: what the editor wants
 * changed, the model to ask, then the proposal with what it changed —
 * "Use this" puts it in the field (Save still keeps it), "Discard" closes
 * the panel and leaves the draft as it was. The rules are
 * project-about.model.ts's; the call is the page's (project-view.tsx).
 */

import type { Dispatch } from 'react';
import {
  canRefine,
  proposalUnchanged,
  type AboutAction,
  type AboutState,
} from './project-about.model';

const fieldClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function RefinePanel({
  state,
  dispatch,
  onAsk,
}: {
  state: AboutState;
  dispatch: Dispatch<AboutAction>;
  onAsk: () => void;
}) {
  const { refine } = state;
  const models = refine.models;
  const close = () => dispatch({ type: 'refineClosed' });

  return (
    <section
      aria-label="Refine instructions"
      className="mt-2 space-y-2 rounded-md border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/20"
    >
      {refine.proposal ? (
        <>
          <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
            Proposed instructions
          </p>
          <pre
            aria-label="Proposed instructions"
            className="max-h-80 overflow-auto rounded-md border border-gray-200 bg-white p-2 font-sans text-sm whitespace-pre-wrap break-words dark:border-gray-800 dark:bg-gray-900"
          >
            {refine.proposal.instructions}
          </pre>
          {refine.proposal.changes.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-300">What changed</p>
              <ul className="ml-4 list-disc text-xs text-gray-600 dark:text-gray-400">
                {refine.proposal.changes.map((change, index) => (
                  <li key={index}>{change}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {proposalUnchanged(state) ? (
            <p className="text-xs text-gray-500">The model found nothing to change.</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAsk}
              disabled={!canRefine(state)}
              className="rounded-md border border-gray-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-gray-700"
            >
              Try again
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-gray-300 px-3 py-1 text-sm dark:border-gray-700"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={proposalUnchanged(state)}
              onClick={() => dispatch({ type: 'proposalAccepted' })}
              className="rounded-md bg-violet-600 px-3 py-1 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              Use this
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            A model rewrites the instructions above to be clearer and better organized, keeping what
            they say. You see the result before anything changes.
          </p>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-500">
              Anything in particular? (optional)
            </span>
            <input
              value={refine.guidance}
              onChange={(event) => dispatch({ type: 'guidanceTyped', text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onAsk();
                }
              }}
              disabled={refine.asking}
              maxLength={2_000}
              placeholder="e.g. make it shorter, add a section on tone"
              className={fieldClass}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {models && models.length > 1 ? (
              <label className="flex min-w-0 items-center gap-1.5 text-xs text-gray-500">
                Model
                <select
                  value={refine.modelId ?? ''}
                  onChange={(event) =>
                    dispatch({ type: 'modelPicked', modelId: event.target.value })
                  }
                  disabled={refine.asking}
                  className="max-w-[12rem] rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-gray-300 px-3 py-1 text-sm dark:border-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onAsk}
              disabled={!canRefine(state) || models === null}
              className="rounded-md bg-violet-600 px-3 py-1 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {refine.asking ? 'Refining…' : 'Refine'}
            </button>
          </div>
        </>
      )}
      {refine.error ? <p className="text-sm text-red-600">{refine.error}</p> : null}
    </section>
  );
}
