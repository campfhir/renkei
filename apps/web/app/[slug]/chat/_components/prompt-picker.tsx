'use client';

/**
 * Pick a prompt from the libraries this person can see — theirs, shared
 * with them, or published to the org — and drop its body into the
 * composer. Filters by title and body.
 */

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/modal';
import { getJson } from '@/lib/fetch-json';
import { LoadingLine } from '@/components/skeleton';
import { Icon, ICONS } from '@/components/icons';

interface PickerPrompt {
  id: string;
  title: string;
  body: string;
  libraryName: string;
}

const COMPACT_COMMAND = {
  title: 'Compact this conversation',
  detail: '/compact · summarize the older part of this chat to free up context',
};

export default function PromptPicker({
  tenantId,
  onClose,
  onPick,
  onCompact,
}: {
  tenantId: string;
  onClose: () => void;
  onPick: (body: string) => void;
  /** Runs a compaction pass instead of inserting text. */
  onCompact: () => void;
}) {
  const [prompts, setPrompts] = useState<PickerPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const showCompact = 'compact'.includes(query.trim().toLowerCase());

  useEffect(() => {
    void getJson<{ prompts: PickerPrompt[] }>(
      `/api/tenant/${tenantId}/chat/prompt-libraries/picker`
    ).then((result) => {
      if (result.error) setError(result.error);
      setPrompts(result.data?.prompts ?? []);
    });
  }, [tenantId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!prompts) return [];
    if (!needle) return prompts;
    return prompts.filter(
      (prompt) =>
        prompt.title.toLowerCase().includes(needle) ||
        prompt.body.toLowerCase().includes(needle) ||
        prompt.libraryName.toLowerCase().includes(needle)
    );
  }, [prompts, query]);

  return (
    <Modal title="Insert a prompt" onClose={onClose}>
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search prompts"
        className="mb-2 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="max-h-80 overflow-y-auto">
        {showCompact ? (
          <button
            type="button"
            onClick={onCompact}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.package} className="h-4 w-4 shrink-0 text-gray-500" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{COMPACT_COMMAND.title}</span>
              <span className="block truncate text-xs text-gray-500">{COMPACT_COMMAND.detail}</span>
            </span>
          </button>
        ) : null}
        {prompts === null ? (
          <LoadingLine label="Loading prompts…" />
        ) : shown.length === 0 ? (
          showCompact ? null : (
            <p className="text-sm text-gray-500">
              {prompts.length === 0 ? 'No prompts yet — create a library first.' : 'No matches.'}
            </p>
          )
        ) : (
          shown.map((prompt) => (
            <button
              key={prompt.id}
              type="button"
              onClick={() => onPick(prompt.body)}
              className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <span className="block text-sm font-medium">{prompt.title}</span>
              <span className="block truncate text-xs text-gray-500">
                {prompt.libraryName} · {prompt.body.replace(/\s+/g, ' ').slice(0, 90)}
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
