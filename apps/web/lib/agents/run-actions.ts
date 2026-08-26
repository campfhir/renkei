/**
 * What a run actually DID, as one ordered list.
 *
 * The timeline answers "how did each step go" — you expand a step, then an
 * attempt, then a tool call. That is the right shape for following the
 * reasoning and the wrong shape for the question people arrive with when an
 * agent misbehaves: *what did it touch?* Answering that meant expanding every
 * step in turn and holding the order in your head.
 *
 * So this flattens the same recorded tool calls into the sequence they
 * happened in, across steps and loop iterations, and counts them.
 *
 * ## Why nothing here says "read" or "write"
 *
 * It would be more useful to separate the calls that CHANGED something from
 * the ones that only looked. The honest obstacle is that a run row stores the
 * tool's name and nothing about its nature, and read-vs-act is decided at
 * registration time from `annotations.readOnlyHint` — reachable only by
 * running the whole registration for a specific user against a database.
 * Guessing from the name would mislabel eventually, and a summary that calls
 * a mutation a read is worse than one that declines to say. If this becomes
 * worth having, record the kind on the attempt at write time; do not infer it
 * here.
 *
 * Redaction carries over from the projection untouched: an attempt whose
 * content the audience may not see contributes a hidden marker, never its
 * calls.
 */

import type { AttemptView, RunDetail } from '@/lib/agents/runs-view';

export interface RunAction {
  /** Position in the run, 1-based — the number the UI shows. */
  ordinal: number;
  /** The step this happened under, already resolved to its name. */
  stepName: string;
  /** 0 when not inside a loop; the 1-based round otherwise. */
  iteration: number;
  attempt: number;
  tool: string;
  failed: boolean;
  durationMs: number | null;
  argsPreview: string | null;
  resultPreview: string | null;
}

export interface RunActivity {
  actions: RunAction[];
  /** Total calls recorded, including any inside redacted attempts. */
  totalCalls: number;
  failedCalls: number;
  /** Distinct tool names, in first-use order — the "what it touched" line. */
  toolsUsed: string[];
  /**
   * Attempts whose content this audience may not see. Their calls are
   * counted (the count is content-free) but not listed, and saying so beats
   * a list that silently omits them.
   */
  hiddenAttempts: number;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function callsOf(attempt: AttemptView): Record<string, unknown>[] {
  if (!isRecord(attempt.detail)) return [];
  const calls = attempt.detail.toolCalls;
  if (!Array.isArray(calls)) return [];
  // Built by push rather than `.filter(isRecord)`: the jsonb element type is
  // JsonValue, and filter narrows the predicate's argument, not the array.
  const records: Record<string, unknown>[] = [];
  for (const call of calls) {
    if (isRecord(call)) records.push(call);
  }
  return records;
}

/**
 * The run's actions in execution order.
 *
 * `nameOf` resolves a step id to its display name — supplied by the caller
 * because the snapshot walk already exists on the page and in the markdown
 * renderer, and duplicating it here would be a third place to keep in step.
 */
export function runActivity(
  run: RunDetail,
  nameOf: (stepId: string, stepIndex: number) => string
): RunActivity {
  const actions: RunAction[] = [];
  const toolsUsed: string[] = [];
  let totalCalls = 0;
  let failedCalls = 0;
  let hiddenAttempts = 0;

  // `run.attempts` is already ordered by (step_index, iteration, attempt) at
  // the query seam, which IS execution order — so this needs no sort of its
  // own, and must not impose one.
  for (const attempt of run.attempts) {
    if (attempt.redacted) {
      if (attempt.toolCallCount > 0) {
        hiddenAttempts += 1;
        totalCalls += attempt.toolCallCount;
      }
      continue;
    }
    for (const call of callsOf(attempt)) {
      const tool = str(call.tool) ?? 'tool';
      const failed = call.isError === true;
      totalCalls += 1;
      if (failed) failedCalls += 1;
      if (!toolsUsed.includes(tool)) toolsUsed.push(tool);
      actions.push({
        ordinal: actions.length + 1,
        stepName: nameOf(attempt.stepId, attempt.stepIndex),
        iteration: attempt.iteration,
        attempt: attempt.attempt,
        tool,
        failed,
        durationMs: typeof call.durationMs === 'number' ? call.durationMs : null,
        argsPreview: str(call.argsPreview),
        resultPreview: str(call.resultPreview),
      });
    }
  }

  return { actions, totalCalls, failedCalls, toolsUsed, hiddenAttempts };
}

/**
 * The one-line headline: how much happened, and did any of it fail.
 *
 * Never empty — a run that called nothing says so, because "no actions" and
 * "we did not look" are different answers and the reader deserves the first.
 */
export function activityHeadline(activity: RunActivity): string {
  if (activity.totalCalls === 0) return 'No tools were called.';
  const calls = `${activity.totalCalls} tool call${activity.totalCalls === 1 ? '' : 's'}`;
  const tools =
    activity.toolsUsed.length > 0
      ? ` across ${activity.toolsUsed.length} tool${activity.toolsUsed.length === 1 ? '' : 's'}`
      : '';
  const failed = activity.failedCalls > 0 ? `, ${activity.failedCalls} failed` : '';
  return `${calls}${tools}${failed}.`;
}
