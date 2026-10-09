import React from 'react';
import { findNodeById, isAgentStepsDoc } from '@renkei/agents';
import { friendlyToolName } from '@/lib/tool-name';
import { activityHeadline, runActivity } from '@/lib/agents/run-actions';
import type { RunDetail } from '@/lib/agents/runs-view';

/**
 * "What it did" — every tool call the run made, in order, above the timeline.
 *
 * The timeline is organised by STEP, which is right for following the
 * reasoning and wrong for the question people arrive with when an agent
 * misbehaves: what did it actually touch, and in what order? Answering that
 * from the timeline meant expanding each step in turn and keeping the
 * sequence in your head.
 *
 * Open by default when something failed, collapsed otherwise: on a healthy
 * run this is reference material, on a broken one it is the first thing to
 * read.
 */
export default function RunActivitySection({ run }: { run: RunDetail }): React.ReactNode {
  const activity = runActivity(run, (stepId, stepIndex) => {
    if (isAgentStepsDoc(run.stepsSnapshot)) {
      const found = findNodeById(run.stepsSnapshot.steps, stepId);
      if (found?.node.name) return found.node.name;
    }
    return `Step ${stepIndex + 1}`;
  });

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
              <p className="text-sm">
                <span className={action.failed ? 'text-red-600 dark:text-red-400' : ''}>
                  {/* The identifier is on the title attribute and the friendly
                      name on the face, matching the tools page: someone
                      debugging wants `jira_create_issue`, everyone else wants
                      "Create a Jira issue". */}
                  <span title={action.tool}>{friendlyToolName(action.tool, null)}</span>
                  {action.failed ? ' — failed' : ''}
                </span>
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {action.stepName}
                {action.iteration > 0 ? ` · iteration ${action.iteration}` : ''}
                {action.attempt > 1 ? ` · attempt ${action.attempt}` : ''}
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
            {activity.hiddenAttempts} attempt
            {activity.hiddenAttempts === 1 ? '' : 's'} had their calls hidden for this audience.
          </li>
        ) : null}
      </ol>
    </details>
  );
}
