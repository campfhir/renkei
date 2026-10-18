import React from 'react';
import { friendlyToolName } from '@/lib/tool-name';
import { activityHeadline, runActivity } from '@/lib/agents/run-actions';
import type { RunDetail } from '@/lib/agents/runs-view';

/**
 * "What it did" — everything the run touched, in order, above the timeline:
 * what it READ (its own calls) and what it CHANGED (staged actions the
 * executor made once they were accepted).
 *
 * The timeline is organised by TURN, which is right for following the
 * reasoning and wrong for the question people arrive with when an agent
 * misbehaves: what did it actually touch, and in what order?
 *
 * Open by default when something failed, collapsed otherwise: on a healthy
 * run this is reference material, on a broken one it is the first thing to
 * read.
 */
export default function RunActivitySection({ run }: { run: RunDetail }): React.ReactNode {
  const activity = runActivity(run);

  // Nothing recorded and nothing withheld: the timeline already says the run
  // did not get far, and an empty panel would just be furniture.
  if (activity.totalCalls === 0) return null;

  return (
    <details
      open={activity.failedCalls > 0}
      className="mb-4 rounded-lg border border-gray-200 dark:border-gray-800"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
        What it did
        <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
          {activityHeadline(activity)}
        </span>
      </summary>

      <ol className="border-t border-gray-100 px-4 py-3 dark:border-gray-800">
        {activity.actions.map((action) => (
          <li
            key={`${action.ordinal}`}
            className="flex gap-3 border-b border-gray-100 py-2 last:border-0 dark:border-gray-900"
          >
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-gray-400">
              {action.ordinal}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-sm">
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    action.kind === 'change'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                  }`}
                >
                  {action.kind === 'change' ? 'change' : 'read'}
                </span>
                <span
                  className={
                    action.failed
                      ? 'text-red-600 dark:text-red-400'
                      : action.notMade
                        ? 'text-gray-400 line-through dark:text-gray-500'
                        : ''
                  }
                >
                  {/* The identifier is on the title attribute and the friendly
                      name on the face, matching the tools page. */}
                  <span title={action.tool}>{friendlyToolName(action.tool, null)}</span>
                </span>
                {action.failed ? (
                  <span className="text-xs text-red-600 dark:text-red-400">failed</span>
                ) : action.notMade ? (
                  <span className="text-xs text-gray-500">not made (declined or skipped)</span>
                ) : null}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Turn {action.turn}
                {action.durationMs !== null ? ` · ${action.durationMs}ms` : ''}
              </p>
              {action.argsPreview ? (
                <p className="mt-0.5 break-all font-mono text-[0.65rem] text-gray-500 dark:text-gray-400">
                  {action.argsPreview}
                </p>
              ) : null}
            </div>
          </li>
        ))}
        {activity.hiddenAttempts > 0 ? (
          <li className="pt-2 text-xs text-gray-500 dark:text-gray-400">
            {activity.hiddenAttempts} turn
            {activity.hiddenAttempts === 1 ? '' : 's'} had their calls hidden for this audience.
          </li>
        ) : null}
      </ol>
    </details>
  );
}
