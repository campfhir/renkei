/**
 * Auto mode: a chat given a task and left to finish it, the way Claude
 * Code's auto mode works a task through without stopping at every
 * permission prompt. Two things change when a code project's chat has
 * it on (`chats.auto_mode`, migration 111):
 *
 *  - Nothing asks. Every tool the chat may call runs without the card —
 *    the person's blocked tools (permission-prefs.ts) stay blocked, and
 *    org read-only mode still offers no act tool at all, but a commit,
 *    a push, a pull request, a Jira comment go through unasked. The
 *    person chose this for the chat, and Stop is always there.
 *  - A turn that hands work to a sub-agent (`code_delegate`) does not
 *    end when the model stops talking without `task_complete` having
 *    been called: the runner answers with a nudge row (kind 'nudge',
 *    role user) telling the model to carry on, and the loop goes again —
 *    inside the same turn, so the chat's one-running-turn rule, its wall
 *    clock and Stop all still hold. `task_complete` is the model's word
 *    that the delegated work is done (or that it truly needs the
 *    person), and ends the turn as a plain reply would.
 *    AUTO_MAX_CONTINUES bounds a model that never says so. A turn that
 *    never delegated is never nudged: answering directly, or doing the
 *    work itself in this same reply, is finished the moment the reply
 *    is — only a sub-agent leaves something that can be mid-flight when
 *    the model stops talking (turn-runner.ts's `spawnedSubagent`).
 *
 * Only a code project's chat honours the switch (start-turn.ts): its
 * turns already run under working-session limits (lib/code/turn.ts),
 * and its act tools are the repository's. An ordinary chat stores the
 * flag and ignores it.
 */

import { errorResult, textResult, type LocalTool } from './local-tools';

/** The tool the model calls to end an auto-mode task; read-only, so it never asks. */
export const TASK_COMPLETE_TOOL = 'task_complete';

/** How many times one turn nudges the model on before giving up on it. */
export const AUTO_MAX_CONTINUES = 20;

export type TaskOutcome = 'done' | 'needs_input';

/**
 * What the runner writes as the person when a reply ends with the task
 * still open — plain, and the same every time, so the model learns the
 * loop from the transcript itself.
 */
export const AUTO_NUDGE_TEXT =
  'Auto mode: a sub-agent was started for this task and it has not been marked complete. Carry on with it — check what remains, do the next piece, run what proves it. ' +
  `When it is genuinely finished and verified, call ${TASK_COMPLETE_TOOL} with outcome "done" and a summary; if you truly cannot proceed without the person, call it with outcome "needs_input" and say what you need.`;

/** The system prompt's brief for an auto-mode turn (request-builder.ts). */
export const AUTO_BRIEF =
  'Auto mode is on: you are working unattended on the task the person gave you, and your tools run without asking for permission. Work it through to completion in this reply — decide rather than ask, act rather than propose, verify with the project’s own checks, and keep going after a setback. ' +
  `${TASK_COMPLETE_TOOL} only matters once you have delegated part of the task to a sub-agent (code_delegate): once every sub-agent you started has reported and its work is verified, call it with outcome "done" and a short summary of what changed and what you ran; if you truly cannot proceed without the person (a missing credential, a choice with material consequences that the task leaves open), call it with outcome "needs_input" and say exactly what you need instead. ` +
  `If a turn that started a sub-agent stops without calling ${TASK_COMPLETE_TOOL}, you will simply be told to continue. A reply that answers directly, or that does the work itself without delegating, needs no ${TASK_COMPLETE_TOOL} call at all — just answer normally.`;

/** The recorded end of a task: what the model said when it called task_complete. */
export interface TaskCompletion {
  outcome: TaskOutcome;
  summary: string;
}

/** The task_complete tool's arguments, read; null when they do not name an outcome. */
export function parseTaskCompletion(input: unknown): TaskCompletion | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record: { outcome?: unknown; summary?: unknown } = input;
  if (record.outcome !== 'done' && record.outcome !== 'needs_input') return null;
  return {
    outcome: record.outcome,
    summary: typeof record.summary === 'string' ? record.summary.trim() : '',
  };
}

export function taskCompleteTool(): LocalTool {
  return {
    def: {
      name: TASK_COMPLETE_TOOL,
      description:
        'Auto mode only, and only if you delegated part of this task to a sub-agent (code_delegate): ' +
        'mark the task finished. Call it with outcome "done" once every sub-agent you started has ' +
        'reported and the task is genuinely complete and verified, or "needs_input" when you cannot ' +
        'proceed without the person — then say so in your reply. A turn that started a sub-agent and ' +
        'ends without calling this is answered with a request to continue; a reply that never ' +
        'delegated needs no call to this at all.',
      inputSchema: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['done', 'needs_input'] },
          summary: {
            type: 'string',
            maxLength: 4_000,
            description: 'What was done and verified, or what is needed from the person.',
          },
        },
        required: ['outcome'],
      },
    },
    readOnly: true,
    async execute(input) {
      const completion = parseTaskCompletion(input);
      if (!completion) return errorResult('outcome must be "done" or "needs_input".');
      return textResult(
        completion.outcome === 'done'
          ? 'Noted: the task is marked complete. Finish your reply with what changed and what you ran.'
          : 'Noted: the task is waiting on the person. Finish your reply by saying exactly what you need from them.'
      );
    },
  };
}
