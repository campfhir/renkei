/**
 * A sub-agent for a code project: `code_delegate` hands one bounded task
 * to a fresh model loop with its own instructions and the same checkout
 * tools, and answers with that loop's final report. The orchestrating
 * chat stays in charge — it decides what to delegate, reads the report,
 * and alone commits and pushes (a sub-agent cannot push or delegate
 * further). A sub-agent runs on the model the orchestrator picks for the
 * task from the org's roster (`model` — a cheaper, faster one for a
 * search, the strongest for a hard change), or on the turn's own model
 * when it names none; either way its calls are counted against the
 * turn's usage, stamped in the ledger with the model that actually
 * answered.
 *
 * The point of delegating is what stays OUT of the chat: the sub-agent's
 * file reads, searches, edits and test runs are its own conversation,
 * never the orchestrator's, so the chat's context holds the report and
 * not the hundred results behind it. That conversation is not thrown
 * away, though: when the turn hands the tool a recorder
 * (LocalToolContext.subagents, lib/chat/subagent-runs.ts) the run is
 * kept — task, progress after every model call, and the whole transcript
 * at the end — keyed to the delegating call, for the thread's card and
 * the transcript a person can open. Progress reaches the page live
 * through the same recorder; the report comes back as the tool result.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  resolveAgentLlm,
  streamOrComplete,
  type LlmContentBlock,
  type LlmErrorKind,
  type LlmMessage,
  type LlmToolDef,
  type ResolveLlmError,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import type { LlmCallModel } from '@renkei/agents/runs';
import { clipOutput } from '@renkei/connector-sandbox';
import type { Result } from '@campfhir/safe-functions/types';
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
const RESULT_MAX_CHARS = 30_000;
const REPORT_MAX_CHARS = 20_000;
const TASK_MAX_CHARS = 20_000;
const INSTRUCTIONS_MAX_CHARS = 20_000;

/**
 * Error kinds worth a retry within one step: transport and provider hiccups
 * that the next attempt often clears on its own. `auth` and `invalid_request`
 * describe the request or credentials, not the moment, so retrying changes
 * nothing; `aborted` is the caller's own decision, never a fault to retry.
 */
const RETRYABLE_LLM_ERRORS = new Set<LlmErrorKind>([
  'network',
  'timeout',
  'rate_limit',
  'overloaded',
  'provider_error',
]);
const MODEL_CALL_MAX_ATTEMPTS = 3;
const MODEL_CALL_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The delegating tool's own name — start-turn.ts gates auto mode's task_complete nudge on it. */
export const CODE_DELEGATE_TOOL = 'code_delegate';

/** Tools a sub-agent never gets: publishing and further delegation stay with the orchestrator. */
const WITHHELD = new Set(['code_git_push', CODE_DELEGATE_TOOL, 'code_clone']);

const SUB_AGENT_BRIEF = `You are a sub-agent working in a repository's checkout on behalf of an orchestrating assistant, which gave you one task and will read your report. Use the code_* tools to do the task yourself: look before you change anything, make the change, run what proves it (the project's tests, lint or build) and read the output. Do not push, do not open pull requests, do not ask questions — decide, act, and report. Your final message is your report: what you did, which files you changed, what you ran and what it said, and anything you could not do or are unsure of. Be concrete and brief.`;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One of the org's enabled models (llm_model_configs), as offered to the
 * orchestrator for a sub-agent: what `listChatModels` (lib/chat/models.ts)
 * lists for the composer's own picker, minus what only the composer needs.
 */
export interface SubagentModelChoice {
  id: string;
  label: string;
  provider: string;
  model: string;
  isDefault: boolean;
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
  resolve?: (
    db: Kysely<DB>,
    tenantId: string,
    modelConfigId: string
  ) => Promise<Result<ResolvedLlm, ResolveLlmError>>;
}

/** The ledger's view of the model a sub-agent ran on. */
export function subagentModelOf(llm: ResolvedLlm): LlmCallModel {
  return { provider: llm.providerName, model: llm.model, llmModelId: llm.modelConfigId };
}

/**
 * The choice the orchestrator named, by config id, label or provider
 * model name (label and name case-insensitively); null when nothing
 * offered matches.
 */
export function matchSubagentModel(
  models: SubagentModelChoice[],
  wanted: string
): SubagentModelChoice | null {
  const needle = wanted.trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  return (
    models.find((choice) => choice.id === needle) ??
    models.find((choice) => choice.label.toLowerCase() === lower) ??
    models.find((choice) => choice.model.toLowerCase() === lower) ??
    null
  );
}

/** How the roster reads in the tool's description: one line per model, the default flagged. */
function describeModels(models: SubagentModelChoice[]): string {
  return models
    .map(
      (choice) =>
        `"${choice.label}" (${choice.provider} ${choice.model}${choice.isDefault ? ', the org default' : ''})`
    )
    .join('; ');
}

/**
 * The delegate tool over the given checkout tools. `tools` is the full
 * code_* set for the project; the sub-agent gets it minus what is withheld,
 * and only the read-only part when the task says so.
 */
export function codeDelegateTool(tools: LocalTool[], options: DelegateOptions = {}): LocalTool {
  const offered = tools.filter((tool) => !WITHHELD.has(tool.def.name));
  const models = options.models ?? [];
  const resolve = options.resolve ?? resolveAgentLlm;
  const def: LlmToolDef = {
    name: CODE_DELEGATE_TOOL,
    description:
      'Hand one bounded task to a sub-agent: a fresh model loop with its own instructions and the ' +
      'same repository tools (reading, searching, editing, running commands, committing — never ' +
      'pushing), which works until done and answers with a report. This is the usual way to do ' +
      'anything that takes more than a handful of tool calls — an investigation, finding every ' +
      'place a change touches, one self-contained piece of a change, a test suite run and fixed — ' +
      'because its calls and results stay in its own conversation and only the report enters ' +
      'this one (readOnly for a pure investigation). Give it a complete, self-contained task and ' +
      'say what to report — it sees nothing of this chat — and read its report critically; you ' +
      'remain responsible for the result, for checking what it claims, and for committing and ' +
      `pushing. A sub-agent makes at most maxSteps model calls (default ${DELEGATE_DEFAULT_STEPS}). ` +
      'A person can open its full transcript from this chat, so the report can stay brief.' +
      (models.length > 0
        ? ' A sub-agent need not run on the model answering this chat: pick one per task with ' +
          '`model` — a fast, cheap model for a search or a mechanical edit, the strongest for a ' +
          'change that takes judgement; leave it out to use this chat’s own model. Available: ' +
          `${describeModels(models)}.`
        : ''),
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
        ...(models.length > 0
          ? {
              model: {
                type: 'string',
                maxLength: 200,
                description:
                  'The model the sub-agent runs on, by its label: one of ' +
                  `${models.map((choice) => `"${choice.label}"`).join(', ')}. ` +
                  'Omit to use the model answering this chat.',
              },
            }
          : {}),
      },
      required: ['task'],
    },
  };

  return {
    def,
    timeoutMs: DELEGATE_TOOL_TIMEOUT_MS,
    async execute(input, context: LocalToolContext) {
      const turnLlm = context.llm;
      if (!turnLlm) return errorResult('Sub-agents are not available in this chat.');
      const task = str(input.task).trim();
      if (!task) return errorResult('Say what the sub-agent should do.');
      // The model for this task: the one named, resolved with its own key
      // and settings, or the turn's own. A name that matches nothing
      // offered is refused with the roster rather than quietly run on the
      // default — the orchestrator chose for a reason and should know.
      const wanted = str(input.model).trim();
      let llm = turnLlm;
      if (wanted) {
        const choice = matchSubagentModel(models, wanted);
        if (!choice) {
          return errorResult(
            models.length > 0
              ? `No model called "${wanted}" is available to a sub-agent. Choose one of: ` +
                  `${models.map((entry) => `"${entry.label}"`).join(', ')} — or leave model out.`
              : 'Sub-agents run on this chat’s own model here; leave model out.'
          );
        }
        if (choice.id !== turnLlm.modelConfigId) {
          const resolved = await resolve(context.db, context.tenantId, choice.id);
          // resolveAgentLlm falls back to the org default when the row no
          // longer resolves; that is not what was asked for, so say so.
          if (!resolved.ok || resolved.val.modelConfigId !== choice.id) {
            return errorResult(
              `The model "${choice.label}" cannot be used right now` +
                (resolved.ok ? '' : ` (${friendlyResolveError(resolved.err.type)})`) +
                '. Choose another, or leave model out to use this chat’s own model.'
            );
          }
          llm = resolved.val;
        }
      }
      const model = subagentModelOf(llm);
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
      // The run's record, when the turn keeps one: started now, told
      // after every model call, closed with the transcript at the end.
      const recorder = context.subagents ?? null;
      const runId =
        recorder && context.toolUseId
          ? await recorder.start({
              toolUseId: context.toolUseId,
              task,
              instructions: instructions || null,
              readOnly,
              maxSteps,
              model,
            })
          : null;
      const close = async (
        status: 'completed' | 'failed',
        outcome: string,
        error: string | null,
        steps: number
      ) => {
        if (recorder && runId) {
          await recorder.finish(runId, {
            status,
            transcript: messages,
            report: status === 'completed' ? outcome : null,
            error,
            steps,
            toolCalls: calls.length,
          });
        }
        return status === 'completed' ? textResult(outcome) : errorResult(outcome);
      };

      const callModel = () =>
        streamOrComplete(
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

      for (let step = 1; step <= maxSteps; step += 1) {
        if (Date.now() > deadline) {
          const text = report('stopped: out of time', lastText, calls, step - 1);
          return close('completed', text, 'out of time', step - 1);
        }
        // A step's own model call gets a few attempts before the whole run
        // gives up on it: nothing here has shown the person anything yet
        // (onEvent above is a no-op — a sub-agent's deltas never reach the
        // thread), so retrying from scratch is exactly as safe as trying
        // once. Only a kind that describes the moment, not the request or
        // the credentials, is worth another attempt.
        let result = await callModel();
        for (
          let attempt = 1;
          !result.ok &&
          attempt < MODEL_CALL_MAX_ATTEMPTS &&
          RETRYABLE_LLM_ERRORS.has(result.err.type) &&
          Date.now() < deadline &&
          !controller.signal.aborted;
          attempt += 1
        ) {
          await sleep(MODEL_CALL_RETRY_DELAY_MS * attempt);
          result = await callModel();
        }
        if (!result.ok) {
          const failure =
            `The sub-agent's model call failed: ${friendlyLlmError(result.err.type)}` +
            (lastText ? `\n\nIts last message:\n${lastText}` : '');
          return close('failed', failure, friendlyLlmError(result.err.type), step - 1);
        }
        const reply = result.val;
        if (context.recordUsage) await context.recordUsage(reply.usage, model);
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
          if (recorder && runId) {
            await recorder.progress(runId, {
              steps: step,
              toolCalls: calls.length,
              lastTool: null,
              usage: reply.usage,
            });
          }
          return close('completed', report('done', lastText, calls, step), null, step);
        }
        for (const use of uses) calls.push(use.name);
        if (recorder && runId) {
          await recorder.progress(runId, {
            steps: step,
            toolCalls: calls.length,
            lastTool: uses[uses.length - 1]?.name ?? null,
            usage: reply.usage,
          });
        }
        const results: LlmContentBlock[] = [];
        for (const use of uses) {
          const outcome = await set.run(use.name, use.input, {
            ...context,
            toolUseId: use.id,
            // A sub-agent's own tools record nothing further: one run, one record.
            subagents: undefined,
          });
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
      return close(
        'completed',
        report(`stopped after ${maxSteps} steps (maxSteps)`, lastText, calls, maxSteps),
        `stopped after ${maxSteps} steps`,
        maxSteps
      );
    },
  };
}

function friendlyResolveError(kind: ResolveLlmError): string {
  switch (kind) {
    case 'NO_MODEL':
      return 'it is no longer enabled';
    case 'UNSUPPORTED_PROVIDER':
      return 'its provider has no adapter';
    case 'CONFIG_ERROR':
      return 'its configuration is incomplete';
    case 'DB_ERROR':
      return 'the database could not be read';
  }
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
