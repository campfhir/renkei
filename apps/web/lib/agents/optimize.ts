/**
 * The optimizer: an agent's failures and token spend, read as evidence,
 * put to the org's model, returned as a report with a revision brief.
 *
 * ## What it reads
 *
 *   - The definition itself, rendered the way "Copy as Markdown" renders
 *     it — the same text a person would paste to ask a colleague for help.
 *   - The run log (migration 083): every run's outcome, and for the failed
 *     ones what kind and how often.
 *   - The tool profile from the turn rows: how often each tool was called
 *     and how often it failed, and how many turns a run takes — the numbers
 *     that say where the calls and the spend actually go.
 *   - A few recent failed runs' last turns and failing tool calls, the
 *     content the owner already sees on the run page. Read under the
 *     OWNER's visibility (this runs as them), clipped hard.
 *
 * ## What it does not do
 *
 * It never edits the agent. The report carries a prose brief; turning it
 * into revised instructions is the drafting pipeline's job (apply route), and the builder
 * offers the result for the owner to look at before anything is saved.
 * The model is a reviewer here — the gates and the save validation stay
 * exactly where they are.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { DEFAULT_ORG_SETTINGS, getOrgSettings } from '@renkei/settings';
import { resolveAgentLlm, type LlmUsage } from '@renkei/agent-llm';
import type { LlmCallModel } from '@renkei/agents/runs';
import { logger } from '@/lib/logger';
import { retryWithBackoff } from '@/lib/retry-with-backoff';
import { agentMarkdown } from '@/lib/agents/export-markdown';
import { getRunForOwner, listRunsForOwner } from '@/lib/agents/runs-view';
import type { StoredAgent } from '@/lib/agents/store';
import {
  parseOptimizationReply,
  type OptimizationEvidenceSummary,
  type OptimizationReport,
} from '@/lib/agents/optimization-report';

const ANALYSIS_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_RETRIES = 1;
const RETRY_BACKOFF_OFFSET_MS = 2_000;

/** Budgets that keep the prompt a prompt and not a dump of run history. */
const MAX_FAILURE_ROWS = 25;
const MAX_SAMPLE_RUNS = 3;
const MAX_SAMPLE_CALLS_PER_TURN = 3;
const MAX_SAMPLE_TURNS = 4;
const MAX_TOOL_ROWS = 20;
const CLIP_SUMMARY = 300;
const CLIP_RESULT = 200;
const CLIP_ERROR = 300;

export interface FailureEvidence {
  at: string;
  triggerKind: string;
  errorKind: string | null;
  outcomeCode: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface ToolProfile {
  tool: string;
  calls: number;
  failedCalls: number;
  /** Share of all the agent's tool calls in the window, 0–100. */
  callShare: number;
}

export interface RunStats {
  runs: number;
  succeeded: number;
  failed: number;
  avgTokensPerRun: number;
  maxTokensPerRun: number;
  /** Model turns per run, on average. */
  avgTurnsPerRun: number;
  /** Tool calls per run, on average. */
  avgToolCallsPerRun: number;
}

export interface FailedRunSample {
  runId: string;
  at: string;
  errorKind: string | null;
  error: string | null;
  /** The run's LAST few turns — where it went wrong. */
  turns: {
    turn: number;
    summary: string | null;
    calls: { tool: string; failed: boolean; result: string | null }[];
  }[];
}

export interface OptimizationEvidence {
  windowDays: number;
  stats: RunStats;
  failures: FailureEvidence[];
  tools: ToolProfile[];
  samples: FailedRunSample[];
  /** The org's per-run limits, which the instructions must fit. */
  limits: { minutes: number; toolCalls: number };
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Everything the prompt will be built from. */
export async function gatherOptimizationEvidence(
  db: Kysely<DB>,
  ownerSubject: string,
  agent: StoredAgent,
  windowDays: number
): Promise<OptimizationEvidence> {
  const since = sql<Date>`NOW() - MAKE_INTERVAL(days => ${windowDays})`;

  const [failureRows, statRow, toolRows, failedRuns, settings] = await Promise.all([
    db
      .selectFrom('agent_run_log')
      .select([
        'created_at',
        'trigger_kind',
        'error_kind',
        'outcome_code',
        'error',
        'input_tokens',
        'output_tokens',
        'tool_calls',
      ])
      .where('owner_subject', '=', ownerSubject)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'failed')
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(MAX_FAILURE_ROWS)
      .execute(),
    // Run-level numbers from the durable log, so the window is honoured
    // even past run retention; the tool profile below reads live turn rows
    // and is bounded by it.
    sql<{
      runs: string;
      succeeded: string;
      failed: string;
      avg_tokens: string | null;
      max_tokens: string | null;
      avg_turns: string | null;
      avg_calls: string | null;
    }>`
      SELECT COUNT(*) AS runs,
             COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed,
             AVG(input_tokens + output_tokens) AS avg_tokens,
             MAX(input_tokens + output_tokens) AS max_tokens,
             AVG(attempts) AS avg_turns,
             AVG(tool_calls) AS avg_calls
      FROM agent_run_log
      WHERE owner_subject = ${ownerSubject}
        AND agent_id = ${agent.id}
        AND created_at >= ${since}
        AND status IN ('succeeded', 'failed', 'stopped')
    `.execute(db),
    // The clear half of each turn's detail outlines its tool calls (name
    // and error flag, never content — turn-detail.ts), which is all this
    // profile needs.
    sql<{ tool: string; calls: string; failed: string }>`
      SELECT call->>'tool' AS tool,
             COUNT(*) AS calls,
             COUNT(*) FILTER (WHERE call->>'isError' = 'true') AS failed
      FROM agent_run_steps s
      JOIN agent_runs r ON r.id = s.run_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(s.detail->'toolCalls') = 'array'
             THEN s.detail->'toolCalls' ELSE '[]'::jsonb END
      ) AS call
      WHERE r.owner_subject = ${ownerSubject}
        AND r.agent_id = ${agent.id}
        AND r.created_at >= ${since}
        AND call->>'tool' IS NOT NULL
        AND COALESCE(call->>'free', 'false') <> 'true'
      GROUP BY 1
      ORDER BY calls DESC
      LIMIT ${MAX_TOOL_ROWS}
    `.execute(db),
    listRunsForOwner(db, ownerSubject, agent.id, {
      status: 'failed',
      limit: MAX_SAMPLE_RUNS,
    }),
    getOrgSettings(),
  ]);
  const org = settings.ok ? settings.val : DEFAULT_ORG_SETTINGS;

  const stat = statRow.rows[0];
  const stats: RunStats = {
    runs: Number(stat?.runs ?? 0),
    succeeded: Number(stat?.succeeded ?? 0),
    failed: Number(stat?.failed ?? 0),
    avgTokensPerRun: Math.round(Number(stat?.avg_tokens ?? 0)),
    maxTokensPerRun: Number(stat?.max_tokens ?? 0),
    avgTurnsPerRun: Math.round(Number(stat?.avg_turns ?? 0) * 10) / 10,
    avgToolCallsPerRun: Math.round(Number(stat?.avg_calls ?? 0) * 10) / 10,
  };

  const totalCalls = toolRows.rows.reduce((sum, row) => sum + Number(row.calls), 0);
  const tools: ToolProfile[] = toolRows.rows.map((row) => ({
    tool: row.tool,
    calls: Number(row.calls),
    failedCalls: Number(row.failed),
    callShare: totalCalls > 0 ? Math.round((Number(row.calls) / totalCalls) * 100) : 0,
  }));

  const samples: FailedRunSample[] = [];
  for (const summary of failedRuns) {
    const run = await getRunForOwner(db, ownerSubject, agent.id, summary.id);
    if (!run) continue;
    samples.push({
      runId: run.id,
      at: run.createdAt,
      errorKind: run.errorKind,
      error: clip(run.error, CLIP_ERROR),
      turns: run.attempts
        .filter((turn) => !turn.redacted)
        .slice(-MAX_SAMPLE_TURNS)
        .map((turn) => {
          const detail: { llmSummary?: unknown; toolCalls?: unknown } =
            typeof turn.detail === 'object' && turn.detail !== null && !Array.isArray(turn.detail)
              ? turn.detail
              : {};
          const calls = (Array.isArray(detail.toolCalls) ? detail.toolCalls : []).filter(
            (call): call is { tool?: unknown; isError?: unknown; resultPreview?: unknown } =>
              typeof call === 'object' && call !== null && !Array.isArray(call)
          );
          // Failed calls first — they are the evidence.
          calls.sort(
            (left, right) => Number(right.isError === true) - Number(left.isError === true)
          );
          return {
            turn: turn.attempt,
            summary: clip(detail.llmSummary, CLIP_SUMMARY),
            calls: calls.slice(0, MAX_SAMPLE_CALLS_PER_TURN).map((call) => ({
              tool: typeof call.tool === 'string' ? call.tool : 'tool',
              failed: call.isError === true,
              result: clip(call.resultPreview, CLIP_RESULT),
            })),
          };
        }),
    });
  }

  return {
    windowDays,
    stats,
    failures: failureRows.map((row) => ({
      at: row.created_at.toISOString(),
      triggerKind: row.trigger_kind,
      errorKind: row.error_kind,
      outcomeCode: row.outcome_code,
      error: clip(row.error, CLIP_ERROR),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      toolCalls: row.tool_calls,
    })),
    tools,
    samples,
    limits: { minutes: org.agentRunTimeoutMinutes, toolCalls: org.agentRunToolCallBudget },
  };
}

/** The evidence as the prompt states it — one section per source. */
export function renderEvidence(evidence: OptimizationEvidence): string {
  const lines: string[] = [];
  const { stats } = evidence;
  lines.push(`Window: the last ${evidence.windowDays} days.`);
  lines.push(
    `Limits per run: ${evidence.limits.toolCalls} tool calls, ${evidence.limits.minutes} minutes of active time.`
  );
  lines.push(
    `Runs: ${stats.runs} finished (${stats.succeeded} succeeded, ${stats.failed} failed). ` +
      `Average ${stats.avgTokensPerRun} tokens per run (max ${stats.maxTokensPerRun}), ` +
      `${stats.avgTurnsPerRun} model turns and ${stats.avgToolCallsPerRun} tool calls per run.`
  );

  lines.push('', 'Tool calls (share of all calls in the window):');
  if (evidence.tools.length === 0) lines.push('- (no tool calls recorded in the window)');
  for (const tool of evidence.tools) {
    lines.push(
      `- ${tool.tool}: ${tool.calls} calls, ${tool.failedCalls} failed; ${tool.callShare}% of calls`
    );
  }

  lines.push('', 'Failures (newest first):');
  if (evidence.failures.length === 0) lines.push('- (none in the window)');
  for (const failure of evidence.failures) {
    const code = failure.outcomeCode ? ` [${failure.outcomeCode}]` : '';
    lines.push(
      `- ${failure.at.slice(0, 16).replace('T', ' ')} (${failure.triggerKind}): ` +
        `${failure.errorKind ?? 'failed'}${code}` +
        (failure.error ? ` — ${failure.error}` : '') +
        ` (cost ${failure.inputTokens + failure.outputTokens} tokens, ${failure.toolCalls} tool calls)`
    );
  }

  if (evidence.samples.length > 0) {
    lines.push('', 'How recent failed runs ended (their last turns):');
    for (const sample of evidence.samples) {
      lines.push(
        `Run ${sample.at.slice(0, 16).replace('T', ' ')}: ${sample.errorKind ?? 'failed'}` +
          (sample.error ? ` — ${sample.error}` : '')
      );
      for (const turn of sample.turns) {
        lines.push(`  - turn ${turn.turn}${turn.summary ? `: ${turn.summary}` : ''}`);
        for (const call of turn.calls) {
          lines.push(
            `      ${call.failed ? 'FAILED' : 'ok'} ${call.tool}` +
              (call.result ? ` → ${call.result}` : '')
          );
        }
      }
    }
  }
  return lines.join('\n');
}

export function buildOptimizationPrompt(
  agent: StoredAgent,
  evidence: OptimizationEvidence
): string {
  const definition = agentMarkdown({
    name: agent.name,
    description: agent.description,
    enabled: agent.enabled,
    instructions: agent.instructions,
    tools: agent.tools,
    triggers: agent.triggers,
    guardrails: agent.guardrails,
    canAskQuestions: agent.canAskQuestions,
    autoAcceptActions: agent.autoAcceptActions,
    limits: evidence.limits,
  });
  return [
    'You are reviewing a user-drafted autonomous agent. It works from its instructions with the tools it was given, choosing its own calls and retrying as it sees fit, inside hard per-run limits; it can only change things by staging actions that are accepted and carried out for it. The owner wants it to fail less and cost fewer tokens. You have its definition and its recent run history.',
    '',
    '=== DEFINITION ===',
    definition,
    '',
    '=== EVIDENCE ===',
    renderEvidence(evidence),
    '',
    '=== HOW THE PLATFORM BEHAVES (take as given) ===',
    '- Every model turn re-sends the system prompt (instructions, guardrails, memory) and every tool definition. Long instructions and many selected tools cost tokens on every turn; so do long conversations, which grow with every tool result.',
    '- A run that reaches its tool-call or time limit ends unfinished. Many calls per run, or one tool called over and over, usually means the instructions send the agent searching for something it should be told, or use a per-item tool where a bulk one exists.',
    '- Staged actions that are declined or fail come back to the agent, which may retry them; approvals and questions to the owner are platform features, not problems.',
    '',
    '=== WHAT TO DO ===',
    'Find the REAL causes. Tie every finding to the evidence: quote the failure, the tool or the number that shows it. Do not invent failures the evidence does not show. Prefer few, specific findings over many generic ones.',
    'Areas: "accuracy" (the agent does the wrong thing or gives up: an unclear goal, no "done when", missing identifiers it keeps hunting for, a tool it needs but was not given), "reliability" (external failures the instructions could prepare it for: rate limits, missing records, permission errors), "tokens" (spend that buys nothing: tools selected but never used, instructions that could say the same in a third of the length, searching that a precise identifier in the instructions would avoid).',
    '',
    'Reply with JSON only, no code fences:',
    '{"summary": "...", "findings": [{"area": "accuracy|reliability|tokens", "severity": "high|medium|low", "step": "the instruction section or tool it concerns, or null", "issue": "...", "fix": "...", "evidence": "..."}], "revisionBrief": "...", "expectedImpact": {"failures": "...", "tokens": "..."}}',
    'summary: 2-3 plain sentences for the owner — what is going wrong and what it is costing, no tool identifiers.',
    'findings: 0-8 entries, most important first. "issue" says what is wrong; "fix" is the concrete edit (which section of the instructions, what to say instead; which tool to add or drop); "evidence" cites the numbers or failures it rests on.',
    'revisionBrief: instructions a drafting model can apply to revise the agent — a numbered list of edits, each naming the instruction section (Goal, Context, Approach, Tools, Actions, Done when, Rules) or the tool it changes and saying exactly what to change. Keep everything the edits do not mention exactly as it is. Null if nothing should change.',
    'expectedImpact: one sentence each on failures and on tokens, honest about uncertainty; null when the report does not address one.',
  ].join('\n');
}

export type OptimizeOutcome =
  | {
      report: OptimizationReport;
      usage: LlmUsage;
      /** The model the pass ran on, for the token ledger. */
      model: LlmCallModel;
    }
  | { error: string; detail?: string };

/** The whole pass: evidence → prompt → the org's model → a parsed report. */
export async function optimizeAgent(
  db: Kysely<DB>,
  ownerSubject: string,
  agent: StoredAgent,
  windowDays: number
): Promise<OptimizeOutcome> {
  const llmResult = await resolveAgentLlm(db, agent.llmModelId);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization yet.' };
  }
  const llm = llmResult.val;

  const evidence = await gatherOptimizationEvidence(db, ownerSubject, agent, windowDays);
  if (evidence.stats.runs === 0 && evidence.failures.length === 0) {
    return {
      error: `This agent has not run in the last ${windowDays} days, so there is nothing to analyze yet.`,
    };
  }
  const summary: OptimizationEvidenceSummary = {
    windowDays,
    runs: evidence.stats.runs,
    failures: evidence.stats.failed,
    tokensPerRun: evidence.stats.avgTokensPerRun,
    stepsVersion: agent.revision,
  };

  const startedAt = Date.now();
  const completion = await retryWithBackoff(
    () =>
      llm.provider.complete({
        system:
          'You are a careful reviewer of user-drafted agents. You reason from the evidence you are given, cite it, and reply with strict JSON.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: buildOptimizationPrompt(agent, evidence) }],
          },
        ],
        tools: [],
        maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
        timeoutMs: ANALYSIS_TIMEOUT_MS,
      }),
    {
      timeout: ANALYSIS_TIMEOUT_MS + 30_000,
      maxRetries: MAX_RETRIES,
      backoffStrategy: 'exponential',
      backoffOffset: RETRY_BACKOFF_OFFSET_MS,
      onRetry: (attempt, error, nextDelayMs) => {
        logger.debug('agent optimization retry {attempt}: {error} (waiting {delay}ms)', {
          component: 'agents/optimize',
          agentId: agent.id,
          attempt,
          error: error.message,
          delay: nextDelayMs,
        });
      },
    }
  );

  if (!completion.ok) {
    const kind = completion.err.type;
    const message = completion.err.message?.slice(0, 300);
    logger.warn('agent optimization failed: {kind}', {
      component: 'agents/optimize',
      agentId: agent.id,
      kind,
      ms: Date.now() - startedAt,
    });
    return {
      error:
        kind === 'auth'
          ? "The organization's model rejected its credentials. An operator can fix this under Agent models."
          : `The model could not complete the analysis (${kind}).`,
      ...(message ? { detail: message } : {}),
    };
  }

  const usage = completion.val.usage;
  const text = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  const report = parseOptimizationReply(text, summary);
  logger.info('agent optimization {result} in {ms}ms', {
    component: 'agents/optimize',
    agentId: agent.id,
    result: report ? 'succeeded' : 'unparseable',
    ms: Date.now() - startedAt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    findings: report?.findings.length ?? 0,
  });
  if (!report) {
    return {
      error: 'The model replied in a shape this build could not read. Try again.',
      detail: text.slice(0, 1_000),
    };
  }
  return {
    report,
    usage,
    model: { provider: llm.providerName, model: llm.model, llmModelId: llm.modelConfigId },
  };
}
