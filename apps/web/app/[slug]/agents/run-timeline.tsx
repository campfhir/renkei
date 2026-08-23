/**
 * The step timeline both audiences read — a pure render of whatever the
 * runs-view projection handed the page. REDACTION IS NOT DONE HERE: an
 * attempt without `detail` renders as hidden, and this component has no
 * way to un-hide anything, which is the point of doing the split at the
 * query seam.
 */

import { findNodeById, isAgentStepsDoc } from '@renkei/agents';
import { statusLabel, outcomeCodeLabel } from '@/lib/agents/run-labels';
import type { AttemptView, RunDetail } from '@/lib/agents/runs-view';

function stepName(run: RunDetail, stepId: string, stepIndex: number): string {
  if (isAgentStepsDoc(run.stepsSnapshot)) {
    const found = findNodeById(run.stepsSnapshot.steps, stepId);
    if (found?.node.name) {
      switch (found.node.kind) {
        case 'branch':
          return `Branch: ${found.node.name}`;
        case 'loop':
          return `Loop: ${found.node.name}`;
        case 'group':
          return `Group: ${found.node.name}`;
        case 'action':
        case undefined:
          return found.node.name;
        default: {
          const unhandled: never = found.node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    }
  }
  return `Step ${stepIndex + 1}`;
}

function statusTone(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
    case 'running':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300';
    // A graceful "nothing to do" end — neutral on purpose: not the green of
    // work done, and emphatically not the red of a failure.
    case 'stopped':
      return 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

interface DetailShape {
  resolvedInstruction?: unknown;
  llmSummary?: unknown;
  guidanceUsed?: unknown;
  saveValue?: unknown;
  toolCalls?: unknown;
  chosenPathName?: unknown;
}

function AttemptDetail({ attempt }: { attempt: AttemptView }) {
  if (attempt.redacted) {
    return (
      <p className="mt-1 text-xs italic text-gray-400 dark:text-gray-500">
        Details hidden — this step succeeded.
      </p>
    );
  }
  const detail: DetailShape =
    typeof attempt.detail === 'object' && attempt.detail !== null && !Array.isArray(attempt.detail)
      ? attempt.detail
      : {};
  const toolCalls = Array.isArray(detail.toolCalls) ? detail.toolCalls : [];
  return (
    <div className="mt-1 space-y-1 text-xs text-gray-600 dark:text-gray-400">
      {attempt.outcome === 'path_chosen' && typeof detail.chosenPathName === 'string' ? (
        <p className="font-medium text-indigo-700 dark:text-indigo-300">
          Took path: {detail.chosenPathName}
        </p>
      ) : null}
      {typeof detail.llmSummary === 'string' && detail.llmSummary ? (
        <p>{detail.llmSummary}</p>
      ) : null}
      {typeof detail.guidanceUsed === 'string' && detail.guidanceUsed ? (
        <p>
          <span className="font-medium">Guidance used:</span> {detail.guidanceUsed}
        </p>
      ) : null}
      {typeof detail.saveValue === 'string' ? (
        <p>
          <span className="font-medium">Saved result:</span> {detail.saveValue}
        </p>
      ) : null}
      {toolCalls.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-medium">
            {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-1 pl-3">
            {toolCalls.map((call: unknown, index) => {
              const entry: {
                tool?: unknown;
                argsPreview?: unknown;
                resultPreview?: unknown;
                isError?: unknown;
                durationMs?: unknown;
              } = typeof call === 'object' && call !== null ? call : {};
              return (
                <li key={index} className="rounded bg-gray-50 p-2 dark:bg-gray-900">
                  <p className="font-mono">
                    {typeof entry.tool === 'string' ? entry.tool : 'tool'}
                    {entry.isError === true ? (
                      <span className="ml-1 text-red-600 dark:text-red-400">(error)</span>
                    ) : null}
                    {typeof entry.durationMs === 'number' ? (
                      <span className="ml-1 text-gray-400">{entry.durationMs}ms</span>
                    ) : null}
                  </p>
                  {typeof entry.argsPreview === 'string' ? (
                    <p className="mt-0.5 break-all font-mono text-[0.65rem]">{entry.argsPreview}</p>
                  ) : null}
                  {typeof entry.resultPreview === 'string' ? (
                    <p className="mt-0.5 whitespace-pre-wrap break-words">{entry.resultPreview}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function RunTimeline({ run }: { run: RunDetail }) {
  const byStep = new Map<string, AttemptView[]>();
  for (const attempt of run.attempts) {
    const list = byStep.get(attempt.stepId) ?? [];
    list.push(attempt);
    byStep.set(attempt.stepId, list);
  }

  return (
    <ol className="space-y-3">
      {[...byStep.entries()].map(([stepId, attempts]) => (
        <li key={stepId} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <p className="text-sm font-medium">
            {stepName(run, stepId, attempts[0]?.stepIndex ?? 0)}
          </p>
          <ul className="mt-2 space-y-2">
            {attempts.map((attempt, position) => (
              <li
                key={`${attempt.iteration}-${attempt.attempt}`}
                className="border-l-2 border-gray-200 pl-3 dark:border-gray-700"
              >
                {/* Iteration sub-headers: shown when this attempt starts a
                    new loop round. Old runs (iteration 0 throughout) render
                    exactly as before. */}
                {attempt.iteration > 0 &&
                attempts[position - 1]?.iteration !== attempt.iteration ? (
                  <p className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                    Iteration {attempt.iteration}
                  </p>
                ) : null}
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-gray-500">Attempt {attempt.attempt}</span>
                  <StatusPill status={attempt.status} />
                  {attempt.outcomeCode ? (
                    <span className="rounded-full border border-gray-300 px-2 py-0.5 text-gray-600 dark:border-gray-700 dark:text-gray-400">
                      {outcomeCodeLabel(attempt.outcomeCode)}
                    </span>
                  ) : null}
                  {attempt.toolCallCount > 0 ? (
                    <span className="text-gray-400">
                      {attempt.toolCallCount} tool call{attempt.toolCallCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </p>
                <AttemptDetail attempt={attempt} />
              </li>
            ))}
          </ul>
        </li>
      ))}
      {run.attempts.length === 0 ? (
        <li className="text-sm text-gray-500 dark:text-gray-400">
          No steps ran{run.error ? ` — ${run.error}` : '.'}
        </li>
      ) : null}
    </ol>
  );
}
