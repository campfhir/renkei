/**
 * A sub-agent for a code project: `code_delegate` hands one bounded task
 * to a fresh model loop with its own instructions and the same checkout
 * tools, and answers with that loop's final report. The orchestrating
 * chat stays in charge — it decides what to delegate, reads the report,
 * and alone commits and pushes (a sub-agent cannot push or delegate
 * further). Each sub-agent's calls are made on the turn's own model and
 * counted against the turn's usage; nothing streams to the page until
 * the report comes back as an ordinary tool result.
 */

import {
  streamOrComplete,
  type LlmContentBlock,
  type LlmMessage,
  type LlmToolDef,
} from '@renkei/agent-llm';
import { clipOutput } from '@renkei/connector-sandbox';
import {
  createLocalToolSet,
  errorResult,
  textResult,
  type LocalTool,
  type LocalToolContext,
} from '@/lib/chat/local-tools';
import { friendlyLlmError, textOfResult } from '@/lib/chat/turn-runner';

export const DELEGATE_DEFAULT_STEPS = 40;
export const DELEGATE_MAX_STEPS = 200;
export const DELEGATE_WALL_CLOCK_MS = 45 * 60_000;
const RESULT_MAX_CHARS = 30_000;
const REPORT_MAX_CHARS = 20_000;
const TASK_MAX_CHARS = 20_000;
const INSTRUCTIONS_MAX_CHARS = 20_000;

/** Tools a sub-agent never gets: publishing and further delegation stay with the orchestrator. */
const WITHHELD = new Set(['code_git_push', 'code_delegate', 'code_clone']);

const SUB_AGENT_BRIEF = `You are a sub-agent working in a repository's checkout on behalf of an orchestrating assistant, which gave you one task and will read your report. Use the code_* tools to do the task yourself: look before you change anything, make the change, run what proves it (the project's tests, lint or build) and read the output. Do not push, do not open pull requests, do not ask questions — decide, act, and report. Your final message is your report: what you did, which files you changed, what you ran and what it said, and anything you could not do or are unsure of. Be concrete and brief.`;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The delegate tool over the given checkout tools. `tools` is the full
 * code_* set for the project; the sub-agent gets it minus what is withheld,
 * and only the read-only part when the task says so.
 */
export function codeDelegateTool(tools: LocalTool[]): LocalTool {
  const offered = tools.filter((tool) => !WITHHELD.has(tool.def.name));
  const def: LlmToolDef = {
    name: 'code_delegate',
    description:
      'Hand one bounded task to a sub-agent: a fresh model loop with its own instructions and the ' +
      'same repository tools (reading, searching, editing, running commands, committing — never ' +
      'pushing), which works until done and answers with a report. Use it to split independent ' +
      'pieces of a larger change, to investigate one question in depth (readOnly for a pure ' +
      'investigation), or to keep a long exploration out of this conversation. Give it a complete, ' +
      'self-contained task — it sees nothing of this chat — and read its report critically; you ' +
      'remain responsible for the result, for running the tests, and for committing and pushing. ' +
      `A sub-agent makes at most maxSteps model calls (default ${DELEGATE_DEFAULT_STEPS}).`,
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          minLength: 1,
          maxLength: TASK_MAX_CHARS,
          description:
            'What to do, in full: the goal, the files or area, how to verify, what to report.',
        },
        instructions: {
          type: 'string',
          maxLength: INSTRUCTIONS_MAX_CHARS,
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
          maximum: DELEGATE_MAX_STEPS,
          description: `Model calls the sub-agent may make (default ${DELEGATE_DEFAULT_STEPS}).`,
        },
      },
      required: ['task'],
    },
  };

  return {
    def,
    async execute(input, context: LocalToolContext) {
      const llm = context.llm;
      if (!llm) return errorResult('Sub-agents are not available in this chat.');
      const task = str(input.task).trim();
      if (!task) return errorResult('Say what the sub-agent should do.');
      const instructions = str(input.instructions).trim();
      const readOnly = input.readOnly === true || context.readOnly;
      const maxSteps =
        typeof input.maxSteps === 'number' && Number.isFinite(input.maxSteps)
          ? Math.min(DELEGATE_MAX_STEPS, Math.max(1, Math.floor(input.maxSteps)))
          : DELEGATE_DEFAULT_STEPS;
      const set = createLocalToolSet(
        readOnly ? offered.filter((tool) => tool.readOnly === true) : offered
      );
      const system = instructions
        ? `${SUB_AGENT_BRIEF}\n\nInstructions from the orchestrator:\n${instructions}`
        : SUB_AGENT_BRIEF;
      const messages: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: task }] }];
      const deadline = Date.now() + DELEGATE_WALL_CLOCK_MS;
      const controller = new AbortController();
      const calls: string[] = [];
      let lastText = '';

      for (let step = 1; step <= maxSteps; step += 1) {
        if (Date.now() > deadline) {
          return textResult(report('stopped: out of time', lastText, calls, step - 1));
        }
        const result = await streamOrComplete(
          llm.provider,
          {
            system,
            messages,
            tools: set.defs(),
            ...(set.defs().length > 0 ? { toolChoice: 'auto' as const } : {}),
            maxTokens: llm.maxOutputTokens,
            ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
            promptCache: true,
            timeoutMs: 300_000,
          },
          { onEvent: () => {}, signal: controller.signal }
        );
        if (!result.ok) {
          return errorResult(
            `The sub-agent's model call failed: ${friendlyLlmError(result.err.type)}` +
              (lastText ? `\n\nIts last message:\n${lastText}` : '')
          );
        }
        const reply = result.val;
        if (context.recordUsage) await context.recordUsage(reply.usage);
        messages.push({ role: 'assistant', content: reply.content });
        const text = reply.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim();
        if (text) lastText = text;
        const uses = reply.content.filter(
          (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> =>
            block.type === 'tool_use'
        );
        if (reply.stopReason !== 'tool_use' || uses.length === 0) {
          return textResult(report('done', lastText, calls, step));
        }
        const results: LlmContentBlock[] = [];
        for (const use of uses) {
          calls.push(use.name);
          const outcome = await set.run(use.name, use.input, context);
          const outText = textOfResult(outcome);
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: clipOutput(
              outText || (outcome.isError ? 'The tool failed.' : '(no output)'),
              RESULT_MAX_CHARS
            ).text,
            ...(outcome.isError ? { isError: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
      }
      return textResult(
        report(`stopped after ${maxSteps} steps (maxSteps)`, lastText, calls, maxSteps)
      );
    },
  };
}

function report(outcome: string, text: string, calls: string[], steps: number): string {
  const counts = new Map<string, number>();
  for (const name of calls) counts.set(name, (counts.get(name) ?? 0) + 1);
  const summary = [...counts.entries()].map(([name, count]) => `${name}×${count}`).join(', ');
  return (
    `Sub-agent ${outcome} — ${steps} model call${steps === 1 ? '' : 's'}, ${calls.length} tool call${calls.length === 1 ? '' : 's'}${summary ? ` (${summary})` : ''}.\n\n` +
    `Report:\n${clipOutput(text || '(the sub-agent said nothing)', REPORT_MAX_CHARS).text}`
  );
}
