import React from 'react';
import { getDatabase } from '@renkei/db';
import { readAgentMemory } from '@renkei/agents/memory';
import ClearMemoryButton from './clear-memory-button';
import { unavailableMarker } from '@/lib/chat/content-crypto';
import { unavailableReasonOf } from '@/lib/chat/chat-keys';

/**
 * What this agent currently remembers: the rolling summary (compaction's
 * output) and the raw entry rows, newest first. Rendered inside the
 * overview page's collapsible "Memory" section — the wrapper owns the
 * heading, this component owns only the content.
 *
 * Ownership is the PAGE's concern: the overview page only renders for the
 * owner (getAgent is subject-scoped), so this component just reads.
 */
const MAX_SHOWN_ENTRIES = 30;

export default async function MemoryPanel({
  agentId,
}: {
  agentId: string;
}): Promise<React.ReactNode> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  // Sealed under the owner's automation key; opened through the delegate
  // (readAgentMemory). A key that is not available renders the chat's
  // locked-row marker rather than envelopes.
  const memory = await readAgentMemory(dbResult.val, agentId, {
    maxEntries: MAX_SHOWN_ENTRIES,
  });
  if (memory.unavailable) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="memory-unavailable">
        {unavailableMarker(unavailableReasonOf(memory.unavailable))}
      </p>
    );
  }
  const summary =
    memory.summary !== null
      ? { content: memory.summary, updated_at: memory.summaryUpdatedAt ?? new Date() }
      : null;
  const entries = memory.entries.map((entry) => ({
    id: entry.id,
    content: entry.content,
    created_at: entry.createdAt,
  }));

  if (!summary && entries.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Nothing yet — runs leave notes here (and steps can add their own), so later runs know what
        was already handled.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <ClearMemoryButton agentId={agentId} />
      </div>

      {summary ? (
        <div className="mb-2 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Summary (compacted {new Date(summary.updated_at).toISOString().slice(0, 10)})
          </p>
          <p className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200">
            {summary.content}
          </p>
        </div>
      ) : null}

      {entries.length > 0 ? (
        <ul className="space-y-1">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="break-words rounded-md border border-gray-100 px-3 py-1.5 text-sm dark:border-gray-900"
            >
              <span className="mr-2 whitespace-nowrap text-xs text-gray-400 dark:text-gray-500">
                {new Date(entry.created_at).toISOString().slice(0, 16).replace('T', ' ')}
              </span>
              {entry.content}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        Older entries fold into the summary automatically; runs only ever see a bounded slice.
      </p>
    </div>
  );
}
