'use client';

/**
 * The post-save review: "here's what this agent does — check it."
 *
 * Shows the generated description (the server's plain-language reading of
 * the rules — the spot-check the user asked for), any logic concerns it
 * raised, and any API keys minted by this save, which THIS panel is the
 * only place to ever see. Enabling from here is the deliberate act; a
 * save always lands disabled-or-as-it-was.
 */

import type { MintedApiKey } from '@/lib/agents/store';

export interface ReviewPanelProps {
  description: string | null;
  reviewNotes: string[];
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

        {description ? (
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
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
              {reviewNotes.map((note) => (
                <li key={note}>{note}</li>
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
          {enabled ? (
            <button
              type="button"
              onClick={onDone}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnable}
              disabled={enabling}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {enabling ? 'Turning on…' : 'Looks right — turn it on'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
