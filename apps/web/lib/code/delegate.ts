/**
 * A sub-agent for a code project: `code_delegate` hands one bounded task
 * to a fresh model loop with its own instructions and the same checkout
 * tools, and answers with that loop's final report. The orchestrating
 * chat stays in charge — it decides what to delegate, reads the report
 * and opens the pull request (a sub-agent cannot delegate further). A
 * sub-agent commits and pushes its own work as it goes: a run can last
 * hours, the checkout dies with the sandbox, and work that waited for
 * the orchestrator to push it was lost whenever a restart came first.
 * The loop itself, the model roster and the record kept of the
 * run are lib/chat/subagent.ts's, shared with the ordinary chat's
 * `chat_delegate` (lib/chat/chat-delegate.ts); what is this tool's own
 * is which tools the sub-agent gets and what it is told.
 */

import type { LlmToolDef } from '@renkei/agent-llm';
import {
  createLocalToolSet,
  errorResult,
  type LocalTool,
  type LocalToolContext,
} from '@/lib/chat/local-tools';
import {
  SUBAGENT_INSTRUCTIONS_MAX_CHARS,
  SUBAGENT_TASK_MAX_CHARS,
  modelArgumentSchema,
  modelChoiceDescription,
  pickSubagentLlm,
  runSubagent,
  stepsOf,
  str,
  type ResolveSubagentLlm,
  type SubagentModelChoice,
} from '@/lib/chat/subagent';
import { CODE_DELEGATE_TOOL } from '@/lib/chat/subagent-tools';

export { matchSubagentModel, subagentModelOf, type SubagentModelChoice } from '@/lib/chat/subagent';
/** The delegating tool's own name — start-turn.ts gates auto mode's task_complete nudge on it. */
export { CODE_DELEGATE_TOOL } from '@/lib/chat/subagent-tools';

export const DELEGATE_DEFAULT_STEPS = 40;
export const DELEGATE_MAX_STEPS = 200;
export const DELEGATE_WALL_CLOCK_MS = 45 * 60_000;
/**
 * The orchestrator's own patience for the whole `code_delegate` call — well
 * past the sub-agent's own wall clock so the turn's generic per-tool race
 * (`toolTimeoutMs`, a couple of minutes — right for an ordinary call) never
 * fires on one still legitimately working. A race that DID fire here would
 * not stop the sub-agent — it has no cancellation of its own — only tell
 * the orchestrator (wrongly) that it failed while it kept running, unseen,
 * to a real report the thread would show as permanently failed regardless.
 */
export const DELEGATE_TOOL_TIMEOUT_MS = DELEGATE_WALL_CLOCK_MS + 15 * 60_000;

/**
 * Auto mode's sub-agent (auto-mode.ts): the person has left the chat to
 * work a task through unattended, so one sub-agent may spend hours on a
 * stage of it. Four hours of wall clock, and enough model calls to use
 * them; the orchestrating turn's own wall clock (CODE_TURN_LIMITS, six
 * hours) still bounds the whole task across its stages, and Stop ends a
 * sub-agent at any point.
 */
export const DELEGATE_AUTO_DEFAULT_STEPS = 400;
export const DELEGATE_AUTO_MAX_STEPS = 1_000;
export const DELEGATE_AUTO_WALL_CLOCK_MS = 4 * 60 * 60_000;
export const DELEGATE_AUTO_TOOL_TIMEOUT_MS = DELEGATE_AUTO_WALL_CLOCK_MS + 15 * 60_000;

/**
 * Tools a sub-agent never gets: further delegation, and what outlives or
 * undoes its task. Committing and pushing are not here — see
 * `subagentPushTool` for the one thing its push refuses.
 */
export const WITHHELD_FROM_SUBAGENTS: ReadonlySet<string> = new Set([
  CODE_DELEGATE_TOOL,
  'code_clone',
  // A service or a preview outlives the sub-agent's task; what runs beside
  // the checkout is the orchestrator's call.
  'code_service_start',
  'code_service_stop',
  'code_preview_start',
  'code_preview_stop',
  // Throwing work away is too: a hard reset or a clean undoes what the
  // orchestrator and the person may be counting on. The rest of git —
  // fetch, branches, log, stash, rebase, merge, a sparse checkout — is a
  // sub-agent's to use for its task, as a developer's would be.
  'code_git_reset',
  'code_git_clean',
]);

const SUB_AGENT_BRIEF = `You are a sub-agent working in a repository's checkout on behalf of an orchestrating assistant, which gave you one task and will read your report. Use the code_* tools to do the task yourself: look before you change anything, make the change, run what proves it (the project's tests, lint or build) and read the output; git is yours too — fetch, branches, stash, rebase or merge when the task calls for it (a rebase or merge that stops on conflicts names the files: fix them and continue, or abort). Save your work as you go: the checkout lives on a sandbox that can restart mid-task, and whatever was never pushed is lost with it. So when you change files, commit each piece that stands (code_git_commit, with a message that says what changed and why) and push it straight away (code_git_push) — every few edits on a long task, work in progress included, and always before your report — on the branch the checkout is already on unless the task names another. Never replace a remote branch (no forced push); if a push is refused, say so in your report and carry on. Do not open pull requests, do not ask questions — decide, act, and report. Your final message is your report: what you did, which files you changed, what you ran and what it said, what you committed and whether it is pushed, and anything you could not do or are unsure of. Be concrete and brief.`;

const PUSH_TOOL = 'code_git_push';

/**
 * A sub-agent's push: the project's own, minus replacing a remote branch.
 * A forced push rewrites what the orchestrator and other chats may have
 * fetched, and nobody is asked before a sub-agent's call, so that one
 * stays with the orchestrator.
 */
export function subagentPushTool(push: LocalTool): LocalTool {
  return {
    ...push,
    async execute(input, context) {
      if (input.forceWithLease === true) {
        return errorResult(
          'A sub-agent does not replace a remote branch. Push without forceWithLease, or say in ' +
            'your report that the branch needs a forced push and leave it to the orchestrator.'
        );
      }
      return push.execute(input, context);
    },
  };
}

export interface DelegateOptions {
  /**
   * The models the orchestrator may pick from, named in the tool's
   * description and matched against its `model` argument. Absent or
   * empty, every sub-agent runs on the turn's own model and the argument
   * is not offered.
   */
  models?: SubagentModelChoice[];
  /** How a chosen config becomes a provider — resolveAgentLlm, or a fake in tests. */
  resolve?: ResolveSubagentLlm;
  /** The chat is in auto mode: a sub-agent gets the long limits above. */
  auto?: boolean;
}

/**
 * The delegate tool over the given checkout tools. `tools` is the full
 * code_* set for the project; the sub-agent gets it minus what is withheld,
 * and only the read-only part when the task says so.
 */
export function codeDelegateTool(tools: LocalTool[], options: DelegateOptions = {}): LocalTool {
  const offered = tools
    .filter((tool) => !WITHHELD_FROM_SUBAGENTS.has(tool.def.name))
    .map((tool) => (tool.def.name === PUSH_TOOL ? subagentPushTool(tool) : tool));
  const models = options.models ?? [];
  const auto = options.auto === true;
  const defaultSteps = auto ? DELEGATE_AUTO_DEFAULT_STEPS : DELEGATE_DEFAULT_STEPS;
  const maxSteps = auto ? DELEGATE_AUTO_MAX_STEPS : DELEGATE_MAX_STEPS;
  const wallClockMs = auto ? DELEGATE_AUTO_WALL_CLOCK_MS : DELEGATE_WALL_CLOCK_MS;
  const def: LlmToolDef = {
    name: CODE_DELEGATE_TOOL,
    description:
      'Hand one bounded task to a sub-agent: a fresh model loop with its own instructions and the ' +
      'same repository tools (reading, searching, editing, running commands, committing and ' +
      'pushing as it goes, so its work survives an interruption — never a forced push), which ' +
      'works until done and answers with a report. This is the usual way to do ' +
      'anything that takes more than a handful of tool calls — an investigation, finding every ' +
      'place a change touches, one self-contained piece of a change, a test suite run and fixed — ' +
      'because its calls and results stay in its own conversation and only the report enters ' +
      'this one (readOnly for a pure investigation). Give it a complete, self-contained task and ' +
      'say what to report and which branch to commit and push to — it sees nothing of this chat ' +
      '— and read its report critically; you remain responsible for the result, for checking ' +
      'what it claims, and for seeing that everything it changed is committed and pushed. ' +
      `A sub-agent makes at most maxSteps model calls (default ${defaultSteps}). ` +
      'A person can open its full transcript from this chat, so the report can stay brief.' +
      modelChoiceDescription(models),
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          minLength: 1,
          maxLength: SUBAGENT_TASK_MAX_CHARS,
          description:
            'What to do, in full: the goal, the files or area, how to verify, what to report.',
        },
        instructions: {
          type: 'string',
          maxLength: SUBAGENT_INSTRUCTIONS_MAX_CHARS,
          description:
            'Standing instructions for this sub-agent — the role it plays, conventions to keep, what not to touch.',
        },
        readOnly: {
          type: 'boolean',
          description:
            'Only reading and searching tools: for an investigation that must change nothing.',
        },
        maxSteps: {
          type: 'integer',
          minimum: 1,
          maximum: maxSteps,
          description: `Model calls the sub-agent may make (default ${defaultSteps}).`,
        },
        ...modelArgumentSchema(models),
      },
      required: ['task'],
    },
  };

  return {
    def,
    timeoutMs: auto ? DELEGATE_AUTO_TOOL_TIMEOUT_MS : DELEGATE_TOOL_TIMEOUT_MS,
    async execute(input, context: LocalToolContext) {
      if (!context.llm) return errorResult('Sub-agents are not available in this chat.');
      const task = str(input.task).trim();
      if (!task) return errorResult('Say what the sub-agent should do.');
      const picked = await pickSubagentLlm(
        context,
        str(input.model).trim(),
        models,
        options.resolve
      );
      if (!picked.ok) return picked.error;
      const instructions = str(input.instructions).trim();
      const readOnly = input.readOnly === true || context.readOnly;
      const set = createLocalToolSet(
        readOnly ? offered.filter((tool) => tool.readOnly === true) : offered
      );
      return runSubagent({
        llm: picked.llm,
        system: instructions
          ? `${SUB_AGENT_BRIEF}\n\nInstructions from the orchestrator:\n${instructions}`
          : SUB_AGENT_BRIEF,
        task,
        instructions: instructions || null,
        readOnly,
        maxSteps: stepsOf(input.maxSteps, defaultSteps, maxSteps),
        wallClockMs,
        tools: {
          defs: () => set.defs(),
          run: (name, args, toolUseId) =>
            set.run(name, args, {
              ...context,
              toolUseId,
              // A sub-agent's own tools record nothing further: one run, one record.
              subagents: undefined,
            }),
        },
        context,
      });
    },
  };
}
