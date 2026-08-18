import React from 'react';
import Link from 'next/link';
import LocalTime from '@/components/local-time';
import { statusLabel, errorSummary } from '@/lib/agents/run-labels';
import type { RunSummary } from '@/lib/agents/runs-view';

/**
 * The overview's glance at run history: date + what happened, nothing else —
 * the full story (filters, durations, timelines) lives on the runs page the
 * button below leads to. Purely presentational; the page does the fetch.
 */
export default function RecentRuns({
  slug,
  agentId,
  runs,
}: {
  slug: string;
  agentId: string;
  runs: RunSummary[];
}): React.ReactNode {
  return (
    <div>
      {runs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No runs yet.</p>
      ) : (
        <ul className="space-y-1">
          {runs.map((run) => {
            const failed = run.status === 'failed' && run.errorKind;
            return (
              <li
                key={run.id}
                className="flex items-center justify-between gap-2 rounded-md border border-gray-100 px-3 py-1.5 text-sm dark:border-gray-900"
              >
                <span className="whitespace-nowrap text-xs text-gray-500">
                  <LocalTime at={run.createdAt} />
                </span>
                <span
                  className={
                    failed
                      ? 'truncate text-xs text-red-600 dark:text-red-400'
                      : 'text-xs text-gray-600 dark:text-gray-400'
                  }
                >
                  {failed && run.errorKind
                    ? errorSummary(run.errorKind, run.failedStepName)
                    : statusLabel(run.status)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Link
        href={`/${slug}/agents/${agentId}/runs`}
        className="mt-2 inline-block rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
      >
        View all runs →
      </Link>
    </div>
  );
}
