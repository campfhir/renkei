/**
 * A sub-agent for an ordinary chat: `chat_delegate` hands one bounded
 * piece of work — reading several tickets, searching across systems,
 * comparing documents, gathering what a summary needs — to a fresh model
 * loop over the chat's READING tools, and answers with its report. The
 * chat that is talking with the person stays a conversation: its own
 * context holds the report, not the dozen results behind it, and its own
 * calls stay few and quick — which is what a voice conversation needs
 * most, where every call the main model makes is silence on the line.
 *
 * A sub-agent here can only look. Every tool it gets is one the turn
 * would run without asking (tool-surface.ts's read-only names, the
 * chat's own read-only tools), so nothing a sub-agent does is something
 * the person would have been asked about: creating, changing and sending
 * stay with the chat, where the permission card is. That is also why
 * the delegation itself is read-only and never asks — unlike
 * `code_delegate`, whose sub-agent edits and commits.
 *
 * Connectors beyond the core set are reached the way the chat reaches
 * them: the sub-agent gets its own find_tools over the discoverable
 * reads, and a discovery is callable from its next model call
 * (turn-runner.ts's `discoveredToolsOfMeta`, read here the same way).
 *
 * The loop, the model roster and the record kept of the run are
 * lib/chat/subagent.ts's, shared with `code_delegate`.
 */

import type { LlmToolDef } from '@renkei/agent-llm';
import type { McpClient, McpToolResult } from '@renkei/mcp-client';
import {
  createLocalToolSet,
  errorResult,
  textResult,
  type LocalTool,
  type LocalToolContext,
} from './local-tools';
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
} from './subagent';
import { MOCKUP_TOOL } from '@/lib/mockups/request';
import { ASK_FORM_TOOL } from './ask-form';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { onShutdown } from '@/lib/shutdown';
import { descendantsOf, findTask, isFinished, taskRef, type ChatTaskView } from './tasks/graph';
import { changeTask, listTasks } from './tasks/store';
import { subagentTaskTools } from './tasks/tools';
import { wakeSoon } from './tasks/wake';
import { CHAT_DELEGATE_TOOL } from './subagent-tools';
import { FIND_TOOLS_NAME, findToolsTool } from './tool-discovery';
import type { DiscoverableTool } from './tool-surface';
import { discoveredToolsOfMeta } from './turn-runner';

export { CHAT_DELEGATE_TOOL } from './subagent-tools';

export const CHAT_DELEGATE_DEFAULT_STEPS = 15;
export const CHAT_DELEGATE_MAX_STEPS = 40;
/**
 * Well inside an ordinary turn's own ten minutes (turn-runner.ts's
 * DEFAULT_TURN_LIMITS): a research errand, not a working session.
 */
export const CHAT_DELEGATE_WALL_CLOCK_MS = 6 * 60_000;
/** Past the sub-agent's wall clock, so the turn's per-tool race never fires on one still working. */
export const CHAT_DELEGATE_TOOL_TIMEOUT_MS = CHAT_DELEGATE_WALL_CLOCK_MS + 60_000;
/** What one of the sub-agent's connector calls may take. */
const MCP_CALL_TIMEOUT_MS = 120_000;

const PREVIEW_SUFFIX = '_preview';

const SUB_AGENT_BRIEF = `You are a sub-agent working on behalf of an assistant that is talking with a person in their organization's workspace. The assistant gave you one task and will read your report; the person never sees this conversation. Use the tools to do the task yourself — search, read, compare, count — and answer from what comes back rather than from memory. Every tool here only reads: you cannot create, change or send anything, or ask anyone, so do not try; note what would need doing and leave it to the assistant. Do not ask questions — decide, act, and report. Your final message is your report: what you found, with the identifiers, names, dates and figures the assistant will need to answer (issue keys, page titles, who said what, links the tools gave), what you looked at, and anything you could not find or are unsure of. Be concrete and brief.`;

/** What a sub-agent working one of the chat's tasks is told about it (tasks/tools.ts). */
function taskNote(task: ChatTaskView): string {
  return `You are working task ${taskRef(task)} of the assistant's task list: “${task.title}”${
    task.detail ? ` (${task.detail})` : ''
  }. Besides reading, you may keep that list: record the steps you take as subtasks of ${taskRef(
    task
  )} (chat_task_create with parent ${task.number}), report progress on it with chat_task_update, and complete or fail your subtasks as you go. Your final report completes ${taskRef(
    task
  )} on its own; if the task cannot be done, say so plainly in the report and it is marked failed.`;
}

const DISCOVERY_NOTE = `More of the organization's connectors are available than the tools listed: call ${FIND_TOOLS_NAME} with a few words for what you need, or a connector name, and matching tools become callable at once.`;

/** What the turn resolved for the chat, as far as a reading sub-agent needs it. */
export interface ChatDelegateSurface {
  /** Offered up front on the turn. */
  tools: LlmToolDef[];
  /** Behind find_tools on the turn. */
  discoverable: DiscoverableTool[];
  /** The names, among both, that only read. */
  readOnlyTools: ReadonlySet<string>;
  mcp: McpClient | null;
}

export interface ChatDelegateOptions {
  /** The chat's connector tools for this turn (tool-surface.ts). */
  surface: ChatDelegateSurface;
  /** The chat's own local tools for this turn; only the read-only ones are passed on. */
  localTools: LocalTool[];
  /** The models the orchestrator may pick from — see code_delegate. */
  models?: SubagentModelChoice[];
  /** How a chosen config becomes a provider — resolveAgentLlm, or a fake in tests. */
  resolve?: ResolveSubagentLlm;
}

/** Where a sub-agent's answer turns from the run's counts to its report (subagent.ts). */
const REPORT_MARKER = '\n\nReport:\n';

/**
 * The sub-agent reported (or failed): its task completes with the report,
 * or fails with the reason — unless it was finished meanwhile (the
 * sub-agent's own call, the person's cancel). Then any wait looks again.
 */
async function settleLinkedTask(
  context: LocalToolContext,
  taskId: string,
  outcome: McpToolResult
): Promise<void> {
  const tasks = await listTasks(context.chatId, context.cipher);
  const task = tasks.find((t) => t.id === taskId);
  if (task && !isFinished(task.status)) {
    const said = outcome.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    // The task keeps the report itself, not the run's counts above it (subagent.ts's report()).
    const marker = said.indexOf(REPORT_MARKER);
    const report = (marker >= 0 ? said.slice(marker + REPORT_MARKER.length) : said).trim();
    // Subtasks the sub-agent left open would refuse the completion: they end with it.
    for (const sub of descendantsOf(taskId, tasks).filter((t) => !isFinished(t.status))) {
      await changeTask(context.chatId, context.cipher, sub.id, { status: 'cancelled' }, new Date());
    }
    const settled = await changeTask(
      context.chatId,
      context.cipher,
      taskId,
      {
        status: outcome.isError ? 'failed' : 'completed',
        result:
          report || (outcome.isError ? 'The sub-agent failed.' : 'The sub-agent reported nothing.'),
      },
      new Date()
    );
    if (!settled.ok) {
      logger.warn(
        "a sub-agent of {actor}'s chat finished, but its task could not be marked {status} ({reason}); the task stays open",
        {
          component: 'chat/delegate',
          ...(await whoIs(context.subject)),
          chatId: context.chatId,
          taskId,
          status: outcome.isError ? 'failed' : 'completed',
          reason: settled.reason,
        }
      );
    }
  }
  wakeSoon(context.chatId);
}

/** A connector tool a sub-agent may have: one that only reads, and is not a preview card. */
function readsOnly(name: string, surface: ChatDelegateSurface): boolean {
  return surface.readOnlyTools.has(name) && !name.endsWith(PREVIEW_SUFFIX);
}

function argsOf(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) out[key] = value;
  }
  return out;
}

/**
 * The delegate tool over the turn's reading tools, or null when there is
 * nothing a sub-agent could read with — a chat with no connectors and
 * no files has no errand to hand off.
 */
export function chatDelegateTool(options: ChatDelegateOptions): LocalTool | null {
  const { surface } = options;
  const eager = surface.tools.filter((tool) => readsOnly(tool.name, surface));
  const discoverable = surface.discoverable.filter((entry) => readsOnly(entry.def.name, surface));
  const local = options.localTools.filter(
    (tool) =>
      tool.readOnly === true &&
      tool.def.name !== CHAT_DELEGATE_TOOL &&
      // A sub-agent has no thread to draw the card in; its mockup would be seen by no one.
      tool.def.name !== MOCKUP_TOOL &&
      // Nor a form: its answers go to the person's thread, which a sub-agent is not in.
      tool.def.name !== ASK_FORM_TOOL
  );
  const discovery = surface.mcp ? findToolsTool(discoverable) : null;
  if (eager.length === 0 && discovery === null && local.length === 0) return null;
  const models = options.models ?? [];
  const def: LlmToolDef = {
    name: CHAT_DELEGATE_TOOL,
    description:
      'Hand one bounded piece of work to a sub-agent: a fresh model loop with its own ' +
      'instructions and this chat’s reading tools (searching and reading the organization’s ' +
      'systems, its knowledge base, the web and this chat’s files — nothing that creates, ' +
      'changes or sends anything), which works until done and answers with a report. This is ' +
      'the usual way to do anything that takes more than a call or two — reading several ' +
      'tickets or pages, searching across systems, comparing documents, gathering what a ' +
      'summary needs — because its calls and results stay in its own conversation and only the ' +
      'report enters this one, so you stay quick and can keep talking with the person. Give it a ' +
      'complete, self-contained task and say what to report — it sees nothing of this chat — ' +
      'and read its report critically; anything that must be created, changed or sent stays ' +
      `with you. A sub-agent makes at most maxSteps model calls (default ${CHAT_DELEGATE_DEFAULT_STEPS}). ` +
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
            'What to find out, in full: the question, where to look, what to compare, what to report.',
        },
        instructions: {
          type: 'string',
          maxLength: SUBAGENT_INSTRUCTIONS_MAX_CHARS,
          description:
            'Standing instructions for this sub-agent — the role it plays, what to prefer, what to leave alone.',
        },
        maxSteps: {
          type: 'integer',
          minimum: 1,
          maximum: CHAT_DELEGATE_MAX_STEPS,
          description: `Model calls the sub-agent may make (default ${CHAT_DELEGATE_DEFAULT_STEPS}).`,
        },
        task_id: {
          type: ['string', 'integer'],
          description:
            'A task of this chat’s task list (its number or id) that this sub-agent works: it goes in progress, the sub-agent can add subtasks and progress to it, and the report completes it (or fails it).',
        },
        background: {
          type: 'boolean',
          description:
            'Needs task_id. Return at once and let the sub-agent work while you carry on; its task completes when it reports. Wait for it with chat_task_wait.',
        },
        ...modelArgumentSchema(models),
      },
      required: ['task'],
    },
  };

  return {
    def,
    // Everything it can reach only reads, so the delegation asks no one
    // and may run beside the turn's other reads.
    readOnly: true,
    timeoutMs: CHAT_DELEGATE_TOOL_TIMEOUT_MS,
    async execute(input, context: LocalToolContext) {
      if (!context.llm) return errorResult('Sub-agents are not available in this chat.');
      const task = str(input.task).trim();
      if (!task) return errorResult('Say what the sub-agent should find out.');
      const picked = await pickSubagentLlm(
        context,
        str(input.model).trim(),
        models,
        options.resolve
      );
      if (!picked.ok) return picked.error;
      const instructions = str(input.instructions).trim();
      // The task this sub-agent works, when the call names one: it must be
      // open and free to start, and it goes in progress now.
      let linked: ChatTaskView | null = null;
      if (input.task_id !== undefined && input.task_id !== null && input.task_id !== '') {
        const tasks = await listTasks(context.chatId, context.cipher);
        const found = findTask(tasks, input.task_id);
        if (!found) return errorResult(`No task ${String(input.task_id)} in this chat.`);
        if (isFinished(found.status))
          return errorResult(`${taskRef(found)} is already ${found.status}.`);
        const started = await changeTask(
          context.chatId,
          context.cipher,
          found.id,
          { status: 'in_progress' },
          new Date()
        );
        if (!started.ok) return errorResult(started.reason);
        linked = started.task;
      }
      const background = input.background === true;
      if (background && !linked)
        return errorResult(
          'A background sub-agent needs a task to report to: create one with chat_task_create and pass its number as task_id.'
        );
      const taskTools = linked ? subagentTaskTools() : [];
      const set = createLocalToolSet([...local, ...taskTools, ...(discovery ? [discovery] : [])]);
      // The connector tools callable right now: what was offered up front,
      // plus what find_tools surfaces as the run goes.
      const connector = new Map(eager.map((tool) => [tool.name, tool]));
      const run = async (
        name: string,
        args: unknown,
        toolUseId: string
      ): Promise<McpToolResult> => {
        if (set.has(name)) {
          const outcome = await set.run(name, args, {
            ...context,
            toolUseId,
            // A sub-agent's own tools record nothing further: one run, one record.
            subagents: undefined,
            taskActor: 'subagent',
          });
          // Only reads were searchable, so anything found is a read.
          for (const found of discoveredToolsOfMeta(outcome.meta)) connector.set(found.name, found);
          return outcome;
        }
        if (surface.mcp && connector.has(name)) {
          try {
            return await surface.mcp.callTool(name, argsOf(args), MCP_CALL_TIMEOUT_MS);
          } catch (error) {
            return errorResult(
              `${name} could not be reached: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        return errorResult(
          `The tool ${name} is not available to a sub-agent: it only reads, and calls only the tools it was given.`
        );
      };
      const system =
        SUB_AGENT_BRIEF +
        `\n\nNow is about ${new Date().toISOString()} (UTC). For an exact time, a weekday or a date relative to today, call resolve_date when it is among your tools rather than working it out.` +
        (discovery ? `\n\n${DISCOVERY_NOTE}` : '') +
        (linked ? `\n\n${taskNote(linked)}` : '') +
        (instructions ? `\n\nInstructions from the assistant:\n${instructions}` : '');
      const go = (runContext: LocalToolContext) =>
        runSubagent({
          llm: picked.llm,
          system,
          task,
          instructions: instructions || null,
          readOnly: true,
          maxSteps: stepsOf(input.maxSteps, CHAT_DELEGATE_DEFAULT_STEPS, CHAT_DELEGATE_MAX_STEPS),
          wallClockMs: CHAT_DELEGATE_WALL_CLOCK_MS,
          tools: {
            defs: () => [...set.defs(), ...connector.values()],
            run: (name, args, toolUseId) => run(name, args, toolUseId),
          },
          context: runContext,
        });
      if (!linked) return go(context);
      const taskId = linked.id;
      if (!background) {
        const outcome = await go(context);
        await settleLinkedTask(context, taskId, outcome);
        return outcome;
      }
      // In the background: the turn may end (and suspend on chat_task_wait)
      // while this runs. Its own stop is the process's shutdown, never the
      // turn's Stop; the turn's tool surface is held open until it is done.
      const stop = new AbortController();
      const unsubscribe = onShutdown(() => stop.abort());
      const release = context.holdTurn?.() ?? (() => {});
      void go({ ...context, signal: stop.signal })
        .then((outcome) => settleLinkedTask(context, taskId, outcome))
        .catch(async (error: unknown) => {
          logger.warn(
            "a background sub-agent of {actor}'s chat stopped unexpectedly; its task is marked failed: {error}",
            {
              component: 'chat/delegate',
              ...(await whoIs(context.subject)),
              chatId: context.chatId,
              taskId,
              error: error instanceof Error ? error.message : String(error),
            }
          );
          await settleLinkedTask(
            context,
            taskId,
            errorResult('The sub-agent stopped unexpectedly.')
          );
        })
        .catch(() => {})
        .finally(() => {
          unsubscribe();
          release();
        });
      return textResult(
        `Started a background sub-agent on ${taskRef(linked)} “${linked.title}”. It completes the task when it reports. ` +
          'Carry on with other work, or call chat_task_wait to suspend until it finishes.',
        { taskId }
      );
    },
  };
}
