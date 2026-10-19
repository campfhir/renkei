/**
 * Staged actions — how an agent changes anything.
 *
 * An agent run may call read tools freely, but it never calls a tool that
 * changes a system. It STAGES those calls instead: one `stage_actions` call
 * proposes an ordered batch (a single action or a series — "create the
 * ticket, then comment on the thread"), each with the reason it is part of
 * the plan. Staging ends the agent's turn and hands control away:
 *
 *   1. the engine writes an `agent_action_batches` row ('proposed') and
 *      either raises ONE card for the whole batch, or — when the agent
 *      auto-accepts and nothing requires a person (act-approval.ts) —
 *      accepts it on the owner's behalf;
 *   2. an accepted batch is run by a SEPARATE executor (the agents
 *      worker's `actions` job, under its own token), in order, stopping at
 *      the first failure — the agent's own token cannot reach these tools
 *      at all, so the only way an act call happens is this path;
 *   3. the executor records each action's outcome on the batch and hands
 *      the run back; the agent's `stage_actions` call returns that report
 *      and the agent carries on — adjusting, retrying, or finishing.
 *
 * While the batch waits and runs, the run's active-time clock is stopped:
 * control is out of the agent's hands.
 *
 * This module is the shape both sides agree on, and pure.
 */

import { untrustedBlock } from './untrusted';

/** How many actions one batch may hold. A batch is a plan, not a bulk job. */
export const MAX_STAGED_ACTIONS = 20;
/** The longest reason an action may carry — one or two sentences. */
export const MAX_ACTION_REASON_CHARS = 500;
/** The longest summary a batch may carry. */
export const MAX_BATCH_SUMMARY_CHARS = 1_000;
/** What one action's result keeps for the agent and the card. */
export const ACTION_RESULT_CHARS = 4_000;

export interface StagedAction {
  tool: string;
  args: Record<string, unknown>;
  /** Why this action is part of the plan — shown on the card. */
  reason: string;
}

/**
 * proposed  → waiting on a person (or about to be auto-accepted);
 * accepted  → queued for the executor;
 * declined / expired → never run, reported back as such;
 * executing → the executor has claimed it;
 * completed → every action has an outcome in `results` (some may have failed).
 */
export type ActionBatchStatus =
  'proposed' | 'accepted' | 'declined' | 'expired' | 'executing' | 'completed';

export type ActionOutcome = 'succeeded' | 'failed' | 'skipped';

export interface ActionResult {
  tool: string;
  outcome: ActionOutcome;
  /** The tool's reply (clipped), or why it failed / was skipped. */
  text: string;
  durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Models sometimes pass a nested array or object as its JSON text. Read it
 * rather than reject a batch that is otherwise well formed.
 */
function jsonIfString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * A `stage_actions` call's arguments → the batch, or the reason the call
 * cannot be staged as written (returned to the model as the tool's error
 * so it can correct itself). `stageable` is the set of act tools this run
 * may propose: the agent's own selection, minus the read tools it already
 * calls directly.
 */
export function parseStagedActions(
  input: unknown,
  stageable: ReadonlySet<string>
): { summary: string; actions: StagedAction[] } | { error: string } {
  if (!isRecord(input)) return { error: 'stage_actions needs {summary, actions}.' };
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!summary) return { error: 'stage_actions needs a summary of what the batch does.' };
  const list = jsonIfString(input.actions);
  if (!Array.isArray(list)) {
    return { error: 'stage_actions needs "actions" as an array of {tool, args, reason}.' };
  }
  if (list.length === 0) return { error: 'stage_actions needs at least one action.' };
  if (list.length > MAX_STAGED_ACTIONS) {
    return {
      error: `A batch holds at most ${MAX_STAGED_ACTIONS} actions — stage the first part, then the rest once you see how it went.`,
    };
  }
  const actions: StagedAction[] = [];
  for (const [index, entry] of list.entries()) {
    const at = `Action ${index + 1}`;
    if (!isRecord(entry)) return { error: `${at} must be {tool, args, reason}.` };
    const tool = typeof entry.tool === 'string' ? entry.tool.trim() : '';
    if (!tool) return { error: `${at} needs a tool name.` };
    if (!stageable.has(tool)) {
      return {
        error: `${at}: "${tool}" is not an action tool this agent can stage. Stageable tools: ${[...stageable].join(', ') || 'none'}.`,
      };
    }
    const args = entry.args === undefined ? {} : jsonIfString(entry.args);
    if (!isRecord(args)) return { error: `${at}: args must be an object.` };
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!reason) return { error: `${at} needs a reason — the person accepting it reads it.` };
    actions.push({ tool, args, reason: reason.slice(0, MAX_ACTION_REASON_CHARS) });
  }
  return { summary: summary.slice(0, MAX_BATCH_SUMMARY_CHARS), actions };
}

export function isStagedAction(value: unknown): value is StagedAction {
  return (
    isRecord(value) &&
    typeof value.tool === 'string' &&
    isRecord(value.args) &&
    typeof value.reason === 'string'
  );
}

/** Stored JSON → the batch's actions; malformed entries are dropped. */
export function parseStoredActions(value: unknown): StagedAction[] {
  return Array.isArray(value) ? value.filter(isStagedAction) : [];
}

export function isActionResult(value: unknown): value is ActionResult {
  return (
    isRecord(value) &&
    typeof value.tool === 'string' &&
    (value.outcome === 'succeeded' || value.outcome === 'failed' || value.outcome === 'skipped') &&
    typeof value.text === 'string' &&
    typeof value.durationMs === 'number'
  );
}

/** Stored JSON → the batch's results; malformed entries are dropped. */
export function parseStoredResults(value: unknown): ActionResult[] {
  return Array.isArray(value) ? value.filter(isActionResult) : [];
}

/**
 * What the agent's `stage_actions` call returns once control is handed
 * back: the decision and, when it ran, every action's outcome. Tool replies
 * are fenced as data (untrusted.ts) like any other tool result.
 */
export function batchReportForAgent(input: {
  status: ActionBatchStatus;
  actions: readonly StagedAction[];
  results: readonly ActionResult[];
  /** Who accepted: a person, or auto-accept on the owner's behalf. */
  acceptedBy: 'person' | 'auto' | null;
  comment: string | null;
}): string {
  const comment = input.comment ? ` Their comment: ${input.comment}` : '';
  if (input.status === 'declined') {
    return `The owner declined this batch; none of its actions were made.${comment} Do not stage the same actions again unless the situation has changed.`;
  }
  if (input.status === 'expired') {
    return 'Nobody accepted this batch before it timed out; none of its actions were made.';
  }
  if (input.status !== 'completed') {
    return `The batch is ${input.status}; no outcome has been reported yet.`;
  }
  const lines = input.actions.map((action, index) => {
    const result = input.results[index];
    if (!result) return `${index + 1}. ${action.tool}: no outcome recorded.`;
    const body =
      result.outcome === 'succeeded'
        ? untrustedBlock(`tool:${action.tool}`, result.text)
        : result.text;
    return `${index + 1}. ${action.tool}: ${result.outcome}. ${body}`;
  });
  const failed = input.results.some((result) => result.outcome === 'failed');
  const who = input.acceptedBy === 'auto' ? 'accepted automatically' : 'accepted by the owner';
  return [
    `The batch was ${who} and executed${failed ? ' — it stopped at the first failure; later actions were skipped' : ''}.${comment}`,
    ...lines,
  ].join('\n');
}
