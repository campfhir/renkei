'use client';

/**
 * The save-confirm modal for edits: Update opens it WITHOUT persisting;
 * "Save" is the click that writes to the database (loading state on the
 * button, errors shown right here) and then navigation back to the
 * agent's overview page follows. "Keep editing" just closes it — nothing
 * was saved.
 *
 * The one other thing this modal ever shows is the keys stage: API keys
 * minted by a save are displayed once and only here, so a save that
 * minted any swaps to that stage instead of navigating straight away.
 * A brand-new agent skips the confirm stage entirely (one-click save)
 * and only ever surfaces here for minted keys.
 */

import type { MintedApiKey } from '@/lib/agents/store';

export interface SaveConfirmPanelProps {
  stage: 'confirm' | 'keys';
  apiKeys: MintedApiKey[];
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
  onKeepEditing: () => void;
  onDone: () => void;
}

export function SaveConfirmPanel({
  stage,
  apiKeys,
  saving,
  saveError,
  onSave,
  onKeepEditing,
  onDone,
}: SaveConfirmPanelProps) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-950">
        {stage === 'confirm' ? (
          <>
            <h2 className="text-lg font-semibold">Save your changes?</h2>
            <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
              The agent stays on or off as it is now. A fresh summary of what it does is written
              after saving — you’ll see it on the agent’s page.
            </p>
            {saveError ? (
              <p
                role="alert"
                className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              >
                Not saved — {saveError}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={onKeepEditing}
                disabled={saving}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Saved</h2>
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
            <div className="mt-5 flex items-center justify-end">
              <button
                type="button"
                onClick={onDone}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
