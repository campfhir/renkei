/**
 * What a run actually DID, as one ordered list.
 *
 * The timeline answers "how did each turn go". The question people arrive
 * with when an agent misbehaves is *what did it touch?* — so this flattens
 * the recorded calls into the order they happened in, and counts them.
 *
 * Reads and changes come from different places, and that is what lets
 * this say which is which honestly: the agent itself can only READ (its
 * token carries read tools alone), so every call on a turn row is a read;
 * every CHANGE was a staged action run by the executor, recorded on its
 * batch. A change that was declined, expired or skipped did not happen and
 * is listed as such.
 *
 * Redaction carries over from the projection untouched: content this
 * audience may not see contributes a hidden marker, never its calls.
 */

import type { AttemptView, RunDetail } from '@/lib/agents/runs-view';

export interface RunAction {
  /** Position in the run, 1-based — the number the UI shows. */
  ordinal: number;
  /** The model turn it happened in (a change: the turn that staged it). */
  turn: number;
  /** 'read' — the agent's own call; 'change' — a staged action the executor made. */
  kind: 'read' | 'change';
  tool: string;
  failed: boolean;
  /** A change that never happened (declined, expired, skipped). */
  notMade: boolean;
  durationMs: number | null;
  argsPreview: string | null;
  resultPreview: string | null;
}

export interface RunActivity {
  actions: RunAction[];
  /** Total calls recorded, including any inside redacted turns. */
  totalCalls: number;
  failedCalls: number;
  /** Changes actually made. */
  changesMade: number;
  /** Distinct tool names, in first-use order — the "what it touched" line. */
  toolsUsed: string[];
  /** Turns whose content this audience may not see (their calls are counted, not listed). */
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
  const records: Record<string, unknown>[] = [];
  for (const call of calls) {
    // Built-ins (finishing, remembering, date arithmetic) and the staging
    // call itself are not things the run touched.
    if (isRecord(call) && call.free !== true && call.tool !== 'stage_actions') records.push(call);
  }
  return records;
}

const PREVIEW_CHARS = 2_000;

/** The run's actions in execution order: each turn's reads, then what it staged. */
export function runActivity(run: RunDetail): RunActivity {
  const actions: RunAction[] = [];
  const toolsUsed: string[] = [];
  let totalCalls = 0;
  let failedCalls = 0;
  let changesMade = 0;
  let hiddenAttempts = 0;
  const batchesByTurn = new Map(run.batches.map((batch) => [batch.turn, batch]));
  const use = (tool: string) => {
    if (!toolsUsed.includes(tool)) toolsUsed.push(tool);
  };

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
      use(tool);
      actions.push({
        ordinal: actions.length + 1,
        turn: attempt.attempt,
        kind: 'read',
        tool,
        failed,
        notMade: false,
        durationMs: typeof call.durationMs === 'number' ? call.durationMs : null,
        argsPreview: str(call.argsPreview),
        resultPreview: str(call.resultPreview),
      });
    }
    const batch = batchesByTurn.get(attempt.attempt);
    if (!batch?.actions) continue;
    batch.actions.forEach((staged, index) => {
      const result = batch.results?.[index];
      const made = result?.outcome === 'succeeded';
      const failed = result?.outcome === 'failed';
      totalCalls += 1;
      if (failed) failedCalls += 1;
      if (made) changesMade += 1;
      use(staged.tool);
      actions.push({
        ordinal: actions.length + 1,
        turn: attempt.attempt,
        kind: 'change',
        tool: staged.tool,
        failed,
        notMade: !made && !failed,
        durationMs: result ? result.durationMs : null,
        argsPreview: JSON.stringify(staged.args).slice(0, PREVIEW_CHARS),
        resultPreview: result ? result.text.slice(0, PREVIEW_CHARS) : null,
      });
    });
  }

  return { actions, totalCalls, failedCalls, changesMade, toolsUsed, hiddenAttempts };
}

/**
 * The one-line headline: how much happened, how much of it changed
 * something, and did any of it fail. Never empty.
 */
export function activityHeadline(activity: RunActivity): string {
  if (activity.totalCalls === 0) return 'No tools were called.';
  const calls = `${activity.totalCalls} tool call${activity.totalCalls === 1 ? '' : 's'}`;
  const tools =
    activity.toolsUsed.length > 0
      ? ` across ${activity.toolsUsed.length} tool${activity.toolsUsed.length === 1 ? '' : 's'}`
      : '';
  const changes =
    activity.changesMade > 0
      ? `, ${activity.changesMade} change${activity.changesMade === 1 ? '' : 's'} made`
      : ', nothing changed';
  const failed = activity.failedCalls > 0 ? `, ${activity.failedCalls} failed` : '';
  return `${calls}${tools}${changes}${failed}.`;
}
