/**
 * A sub-agent: a fresh model loop given one bounded task by the chat
 * that is talking with the person, which works until done and answers
 * with a report. What the two delegating tools share lives here — the
 * loop itself, the roster the orchestrator may pick a model from, and
 * the report — while each tool decides what the sub-agent may call:
 * `code_delegate` (lib/code/delegate.ts) the checkout's tools, minus
 * pushing and delegating; `chat_delegate` (chat-delegate.ts) the chat's
 * reading tools, and nothing that changes or sends anything.
 *
 * The point of delegating is what stays OUT of the chat: the sub-agent's
 * reads, searches and runs are its own conversation, never the
 * orchestrator's, so the chat's context holds the report and not the
 * hundred results behind it. That conversation is not thrown away,
 * though: when the turn hands the tool a recorder
 * (LocalToolContext.subagents, subagent-runs.ts) the run is kept — task,
 * progress after every model call, and the whole transcript at the end —
 * keyed to the delegating call, for the thread's card and the transcript
 * a person can open. Progress reaches the page live through the same
 * recorder; the report comes back as the tool result.
 *
 * A sub-agent runs on the model the orchestrator picks for the task from
 * the org's roster (`model` — a cheaper, faster one for a search, the
 * strongest for a hard piece), or on the turn's own model when it names
 * none; either way its calls are counted against the turn's usage,
 * stamped in the ledger with the model that actually answered.
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
import type { McpToolResult } from '@renkei/mcp-client';
import { clipOutput } from '@renkei/connector-sandbox';
import type { Result } from '@campfhir/safe-functions/types';
import { errorResult, textResult, type LocalToolContext } from './local-tools';
import { friendlyLlmError, textOfResult } from './turn-runner';

const RESULT_MAX_CHARS = 30_000;
const REPORT_MAX_CHARS = 20_000;
export const SUBAGENT_TASK_MAX_CHARS = 20_000;
export const SUBAGENT_INSTRUCTIONS_MAX_CHARS = 20_000;

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

export function str(value: unknown): string {
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

export type ResolveSubagentLlm = (
  db: Kysely<DB>,
  tenantId: string,
  modelConfigId: string
) => Promise<Result<ResolvedLlm, ResolveLlmError>>;

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
export function describeModels(models: SubagentModelChoice[]): string {
  return models
    .map(
      (choice) =>
        `"${choice.label}" (${choice.provider} ${choice.model}${choice.isDefault ? ', the org default' : ''})`
    )
    .join('; ');
}

/** The sentence a delegating tool's description ends with when there is a roster to pick from. */
export function modelChoiceDescription(models: SubagentModelChoice[]): string {
  return models.length > 0
    ? ' A sub-agent need not run on the model answering this chat: pick one per task with ' +
        '`model` — a fast, cheap model for a search or a mechanical edit, the strongest for a ' +
        'change that takes judgement; leave it out to use this chat’s own model. Available: ' +
        `${describeModels(models)}.`
    : '';
}

/** The `model` argument, offered only when there is a roster. */
export function modelArgumentSchema(models: SubagentModelChoice[]): Record<string, unknown> {
  return models.length > 0
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
    : {};
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

/**
 * The model for this task: the one named, resolved with its own key and
 * settings, or the turn's own. A name that matches nothing offered is
 * refused with the roster rather than quietly run on the default — the
 * orchestrator chose for a reason and should know.
 */
export async function pickSubagentLlm(
  context: LocalToolContext,
  wanted: string,
  models: SubagentModelChoice[],
  resolve: ResolveSubagentLlm = resolveAgentLlm
): Promise<{ ok: true; llm: ResolvedLlm } | { ok: false; error: McpToolResult }> {
  const turnLlm = context.llm;
  if (!turnLlm) {
    return { ok: false, error: errorResult('Sub-agents are not available in this chat.') };
  }
  if (!wanted) return { ok: true, llm: turnLlm };
  const choice = matchSubagentModel(models, wanted);
  if (!choice) {
    return {
      ok: false,
      error: errorResult(
        models.length > 0
          ? `No model called "${wanted}" is available to a sub-agent. Choose one of: ` +
              `${models.map((entry) => `"${entry.label}"`).join(', ')} — or leave model out.`
          : 'Sub-agents run on this chat’s own model here; leave model out.'
      ),
    };
  }
  if (choice.id === turnLlm.modelConfigId) return { ok: true, llm: turnLlm };
  const resolved = await resolve(context.db, context.tenantId, choice.id);
  // resolveAgentLlm falls back to the org default when the row no longer
  // resolves; that is not what was asked for, so say so.
  if (!resolved.ok || resolved.val.modelConfigId !== choice.id) {
    return {
      ok: false,
      error: errorResult(
        `The model "${choice.label}" cannot be used right now` +
          (resolved.ok ? '' : ` (${friendlyResolveError(resolved.err.type)})`) +
          '. Choose another, or leave model out to use this chat’s own model.'
      ),
    };
  }
  return { ok: true, llm: resolved.val };
}

/** What a sub-agent may call, and how: the delegating tool decides. */
export interface SubagentTools {
  /** The schemas offered on the next model call — may grow as the run discovers tools. */
  defs(): LlmToolDef[];
  run(name: string, input: unknown, toolUseId: string): Promise<McpToolResult>;
}

export interface SubagentRun {
  /** The model the sub-agent runs on, already picked. */
  llm: ResolvedLlm;
  system: string;
  task: string;
  instructions: string | null;
  readOnly: boolean;
  maxSteps: number;
  wallClockMs: number;
  tools: SubagentTools;
  /** The delegating call's context: the recorder, the usage sink, the call's id. */
  context: LocalToolContext;
}

/**
 * The loop: model call, its tool calls, again, until the model stops
 * calling tools, runs out of steps or time, or fails. The report — or
 * the failure — is the tool result the orchestrator reads.
 */
export async function runSubagent(run: SubagentRun): Promise<McpToolResult> {
  const { llm, tools, context } = run;
  const model = subagentModelOf(llm);
  // The transcript kept for a person carries how long each model call
  // took beside the message it produced (subagent-runs.ts reads it
  // back); the provider adapters pick role and content off a message
  // and never see the extra field.
  const messages: (LlmMessage & { durationMs?: number })[] = [
    { role: 'user', content: [{ type: 'text', text: run.task }] },
  ];
  const deadline = Date.now() + run.wallClockMs;
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
          task: run.task,
          instructions: run.instructions,
          readOnly: run.readOnly,
          maxSteps: run.maxSteps,
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

  const callModel = () => {
    const defs = tools.defs();
    return streamOrComplete(
      llm.provider,
      {
        system: run.system,
        messages,
        tools: defs,
        ...(defs.length > 0 ? { toolChoice: 'auto' as const } : {}),
        maxTokens: llm.maxOutputTokens,
        ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
        promptCache: true,
        timeoutMs: 300_000,
      },
      { onEvent: () => {}, signal: controller.signal }
    );
  };

  for (let step = 1; step <= run.maxSteps; step += 1) {
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
    const callStartedAt = Date.now();
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
    // Retries included: what the orchestrator waited for this step.
    const callMs = Date.now() - callStartedAt;
    if (!result.ok) {
      const failure =
        `The sub-agent's model call failed: ${friendlyLlmError(result.err.type)}` +
        (lastText ? `\n\nIts last message:\n${lastText}` : '');
      return close('failed', failure, friendlyLlmError(result.err.type), step - 1);
    }
    const reply = result.val;
    if (context.recordUsage) await context.recordUsage(reply.usage, model, callMs);
    messages.push({ role: 'assistant', content: reply.content, durationMs: callMs });
    const text = reply.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    if (text) lastText = text;
    const uses = reply.content.filter(
      (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
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
      const toolStartedAt = Date.now();
      const outcome = await tools.run(use.name, use.input, use.id);
      const outText = textOfResult(outcome);
      results.push({
        type: 'tool_result',
        toolUseId: use.id,
        content: clipOutput(
          outText || (outcome.isError ? 'The tool failed.' : '(no output)'),
          RESULT_MAX_CHARS
        ).text,
        ...(outcome.isError ? { isError: true } : {}),
        durationMs: Date.now() - toolStartedAt,
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return close(
    'completed',
    report(`stopped after ${run.maxSteps} steps (maxSteps)`, lastText, calls, run.maxSteps),
    `stopped after ${run.maxSteps} steps`,
    run.maxSteps
  );
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

/** `maxSteps` as asked, within the tool's bounds, or the default. */
export function stepsOf(input: unknown, fallback: number, max: number): number {
  return typeof input === 'number' && Number.isFinite(input)
    ? Math.min(max, Math.max(1, Math.floor(input)))
    : fallback;
}
