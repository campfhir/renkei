'use client';

/**
 * The post-save review: "here's what this agent does — check it."
 *
 * Shows the generated description (the server's plain-language reading of
 * the rules — the spot-check the user asked for), any logic concerns it
 * raised, and any API keys minted by this save, which THIS panel is the
 * only place to ever see. Enabling from here is the deliberate act; a
 * save always lands disabled-or-as-it-was.
 *
 * Every path out is ONE click: "Done" finishes (leaving the agent as it
 * is), "Looks right — turn it on" enables AND finishes, "Keep editing"
 * goes back. Brand-new saves skip this panel entirely (unless they minted
 * an API key) — the agent's overview page is their review surface — so an
 * edit is at most two clicks and a create is one.
 */

import type { MintedApiKey } from '@/lib/agents/store';
import type { ReviewNote } from '@/lib/agents/notes';

export interface ReviewPanelProps {
  description: string | null;
  reviewNotes: ReviewNote[];
  /** True while the save-time summary is still being written server-side. */
  descriptionPending: boolean;
  apiKeys: MintedApiKey[];
  enabled: boolean;
  enabling: boolean;
  onEnable: () => void;
  onKeepEditing: () => void;
  onDone: () => void;
}

export function ReviewPanel({
  description,
  reviewNotes,
  descriptionPending,
  apiKeys,
  enabled,
  enabling,
  onEnable,
  onKeepEditing,
  onDone,
}: ReviewPanelProps) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-950">
        <h2 className="text-lg font-semibold">Saved. Here’s what this agent does</h2>

        {descriptionPending ? (
          <p className="mt-3 flex items-center gap-2 rounded-md bg-gray-50 p-3 text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            {/* dark:border-gray-700 is a SHORTHAND — it resets all four edges,
                so the top must be re-asserted or the ring spins invisibly. */}
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 dark:border-gray-700 dark:border-t-blue-400"
            />
            Writing a summary of what this agent does…
          </p>
        ) : description ? (
          <p className="mt-3 rounded-md bg-gray-50 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
            {description}
          </p>
        ) : (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            We couldn’t write a summary yet — the agent is saved and you can still turn it on.
          </p>
        )}

        {reviewNotes.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Worth checking
            </p>
            <ul className="mt-1 list-disc space-y-2 pl-5 text-sm text-gray-700 dark:text-gray-300">
              {reviewNotes.map((note) => (
                <li key={note.issue}>
                  {note.issue}
                  {note.fix ? (
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      Suggestion: {note.fix}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {apiKeys.length > 0 ? (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              API key{apiKeys.length > 1 ? 's' : ''} — copy now, shown only once
            </p>
            {apiKeys.map((minted) => (
              <code
                key={minted.triggerId}
                className="mt-1 block select-all break-all rounded bg-white px-2 py-1 text-xs dark:bg-gray-900"
              >
                {minted.key}
              </code>
            ))}
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onKeepEditing}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
          >
            Keep editing
          </button>
          {/* Confirming is REVIEWING: while the summary is still being
              written there is nothing to have looked at, so the confirm
              buttons wait for it. The builder's poll bounds the wait (~45s)
              by flipping pending off, which unlocks these either way.
              "Done" always finishes as-is; the enable button (off agents
              only) enables and finishes in the same click. */}
          <button
            type="button"
            onClick={onDone}
            disabled={descriptionPending}
            title={descriptionPending ? 'Waiting for the summary…' : undefined}
            className={
              enabled
                ? 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50'
                : 'rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700'
            }
          >
            Done
          </button>
          {!enabled ? (
            <button
              type="button"
              onClick={onEnable}
              disabled={enabling || descriptionPending}
              title={descriptionPending ? 'Waiting for the summary…' : undefined}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {enabling ? 'Turning on…' : 'Looks right — turn it on'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
