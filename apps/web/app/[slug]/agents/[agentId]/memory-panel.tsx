import React from 'react';
import { getDatabase } from '@renkei/db';
import ClearMemoryButton from './clear-memory-button';

/**
 * What this agent currently remembers: the rolling summary (compaction's
 * output) and the raw entry rows, newest first. Rendered on the agent's
 * overview page — the same "read the recipe" surface — because "why did it
 * skip that message?" is answered here, not in the run log.
 *
 * Ownership is the PAGE's concern: the overview page only renders for the
 * owner (getAgent is subject-scoped), so this component just reads.
 */
const MAX_SHOWN_ENTRIES = 30;

export default async function MemoryPanel({
  tenantId,
  agentId,
}: {
  tenantId: string;
  agentId: string;
}): Promise<React.ReactNode> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  const rows = await dbResult.val
    .selectFrom('agent_memories')
    .select(['id', 'kind', 'content', 'created_at', 'updated_at'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(MAX_SHOWN_ENTRIES + 1)
    .execute();

  const summary = rows.find((row) => row.kind === 'summary');
  const entries = rows.filter((row) => row.kind === 'entry').slice(0, MAX_SHOWN_ENTRIES);

  if (!summary && entries.length === 0) {
    return (
      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold">Memory</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Nothing yet — runs leave notes here (and steps can add their own), so later runs know what
          was already handled.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Memory</h2>
        <ClearMemoryButton tenantId={tenantId} agentId={agentId} />
      </div>

      {summary ? (
        <div className="mb-2 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Summary (compacted {new Date(summary.updated_at).toISOString().slice(0, 10)})
          </p>
          <p className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">
            {summary.content}
          </p>
        </div>
      ) : null}

      {entries.length > 0 ? (
        <ul className="space-y-1">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="rounded-md border border-gray-100 px-3 py-1.5 text-sm dark:border-gray-900"
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
    </section>
  );
}
