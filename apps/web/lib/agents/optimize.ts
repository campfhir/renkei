/**
 * The optimizer: an agent's failures and token spend, read as evidence,
 * put to the org's model, returned as a report with a revision brief.
 *
 * ## What it reads
 *
 *   - The definition itself, rendered the way "Copy as Markdown" renders
 *     it — the same text a person would paste to ask a colleague for help.
 *   - The run log (migration 083): every run's outcome, and for the failed
 *     ones which step, what kind, how often.
 *   - The per-step cost profile from `agent_run_steps`: attempts, failed
 *     attempts, and average tokens per attempt for every step that ran in
 *     the window — the numbers that say where the spend actually goes.
 *   - A few recent failed runs' step summaries and failing tool calls, the
 *     content the owner already sees on the run page. Read under the
 *     OWNER's visibility (this runs as them), clipped hard.
 *
 * ## What it does not do
 *
 * It never edits the agent. The report carries a prose brief; turning it
 * into steps is the drafting pipeline's job (apply route), and the builder
 * offers the result for the owner to look at before anything is saved.
 * The model is a reviewer here — the gates and the save validation stay
 * exactly where they are.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { findNodeById, isAgentStepsDoc, type AgentStepsDoc } from '@renkei/agents';
import { resolveAgentLlm } from '@renkei/agent-llm';
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
const MAX_SAMPLE_CALLS_PER_ATTEMPT = 3;
const CLIP_SUMMARY = 300;
const CLIP_RESULT = 200;
const CLIP_ERROR = 300;

export interface FailureEvidence {
  at: string;
  triggerKind: string;
  stepName: string | null;
  errorKind: string | null;
  outcomeCode: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface StepProfile {
  stepId: string;
  stepName: string;
  attempts: number;
  failedAttempts: number;
  /** Average per attempt, both directions. */
  avgInputTokens: number;
  avgOutputTokens: number;
  avgToolCalls: number;
  /** Share of the agent's total tokens in the window, 0–100. */
  tokenShare: number;
}

export interface RunStats {
  runs: number;
  succeeded: number;
  failed: number;
  avgTokensPerRun: number;
  maxTokensPerRun: number;
  avgAttemptsPerRun: number;
}

export interface FailedRunSample {
  runId: string;
  at: string;
  errorKind: string | null;
  error: string | null;
  attempts: {
    stepName: string;
    attempt: number;
    outcomeCode: string | null;
    summary: string | null;
    calls: { tool: string; failed: boolean; result: string | null }[];
  }[];
}

export interface OptimizationEvidence {
  windowDays: number;
  stats: RunStats;
  failures: FailureEvidence[];
  steps: StepProfile[];
  samples: FailedRunSample[];
}

function stepNameOf(doc: AgentStepsDoc, stepId: string): string {
  const found = findNodeById(doc.steps, stepId);
  return found?.node.name?.trim() || `step ${stepId.slice(0, 8)}`;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Everything the prompt will be built from. */
export async function gatherOptimizationEvidence(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agent: StoredAgent,
  windowDays: number
): Promise<OptimizationEvidence> {
  const since = sql<Date>`NOW() - MAKE_INTERVAL(days => ${windowDays})`;

  const [failureRows, statRow, stepRows, failedRuns] = await Promise.all([
    db
      .selectFrom('agent_run_log')
      .select([
        'created_at',
        'trigger_kind',
        'step_name',
        'error_kind',
        'outcome_code',
        'error',
        'input_tokens',
        'output_tokens',
        'tool_calls',
      ])
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', ownerSubject)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'failed')
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(MAX_FAILURE_ROWS)
      .execute(),
    // Run-level numbers from the durable log, so the window is honoured
    // even past run retention; the step profile below reads live attempt
    // rows and is bounded by it.
    sql<{
      runs: string;
      succeeded: string;
      failed: string;
      avg_tokens: string | null;
      max_tokens: string | null;
      avg_attempts: string | null;
    }>`
      SELECT COUNT(*) AS runs,
             COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed,
             AVG(input_tokens + output_tokens) AS avg_tokens,
             MAX(input_tokens + output_tokens) AS max_tokens,
             AVG(attempts) AS avg_attempts
      FROM agent_run_log
      WHERE tenant_id = ${tenantId}
        AND owner_subject = ${ownerSubject}
        AND agent_id = ${agent.id}
        AND created_at >= ${since}
        AND status IN ('succeeded', 'failed', 'stopped')
    `.execute(db),
    sql<{
      step_id: string;
      attempts: string;
      failed: string;
      avg_in: string | null;
      avg_out: string | null;
      sum_tokens: string | null;
      avg_calls: string | null;
    }>`
      SELECT s.step_id,
             COUNT(*) AS attempts,
             COUNT(*) FILTER (WHERE s.status = 'failed') AS failed,
             AVG(s.input_tokens) AS avg_in,
             AVG(s.output_tokens) AS avg_out,
             SUM(s.input_tokens + s.output_tokens) AS sum_tokens,
             AVG(s.tool_call_count) AS avg_calls
      FROM agent_run_steps s
      JOIN agent_runs r ON r.id = s.run_id
      WHERE s.tenant_id = ${tenantId}
        AND r.owner_subject = ${ownerSubject}
        AND r.agent_id = ${agent.id}
        AND r.created_at >= ${since}
      GROUP BY s.step_id
      ORDER BY sum_tokens DESC NULLS LAST
    `.execute(db),
    listRunsForOwner(db, tenantId, ownerSubject, agent.id, {
      status: 'failed',
      limit: MAX_SAMPLE_RUNS,
    }),
  ]);

  const stat = statRow.rows[0];
  const stats: RunStats = {
    runs: Number(stat?.runs ?? 0),
    succeeded: Number(stat?.succeeded ?? 0),
    failed: Number(stat?.failed ?? 0),
    avgTokensPerRun: Math.round(Number(stat?.avg_tokens ?? 0)),
    maxTokensPerRun: Number(stat?.max_tokens ?? 0),
    avgAttemptsPerRun: Math.round(Number(stat?.avg_attempts ?? 0) * 10) / 10,
  };

  const totalTokens = stepRows.rows.reduce((sum, row) => sum + Number(row.sum_tokens ?? 0), 0);
  const steps: StepProfile[] = stepRows.rows.map((row) => ({
    stepId: row.step_id,
    stepName: stepNameOf(agent.steps, row.step_id),
    attempts: Number(row.attempts),
    failedAttempts: Number(row.failed),
    avgInputTokens: Math.round(Number(row.avg_in ?? 0)),
    avgOutputTokens: Math.round(Number(row.avg_out ?? 0)),
    avgToolCalls: Math.round(Number(row.avg_calls ?? 0) * 10) / 10,
    tokenShare: totalTokens > 0 ? Math.round((Number(row.sum_tokens ?? 0) / totalTokens) * 100) : 0,
  }));

  const samples: FailedRunSample[] = [];
  for (const summary of failedRuns) {
    const run = await getRunForOwner(db, tenantId, ownerSubject, agent.id, summary.id);
    if (!run) continue;
    const snapshot = isAgentStepsDoc(run.stepsSnapshot) ? run.stepsSnapshot : agent.steps;
    samples.push({
      runId: run.id,
      at: run.createdAt,
      errorKind: run.errorKind,
      error: clip(run.error, CLIP_ERROR),
      attempts: run.attempts
        .filter((attempt) => attempt.status === 'failed' && !attempt.redacted)
        .map((attempt) => {
          const detail: { summary?: unknown; toolCalls?: unknown } =
            typeof attempt.detail === 'object' &&
            attempt.detail !== null &&
            !Array.isArray(attempt.detail)
              ? attempt.detail
              : {};
          const calls = Array.isArray(detail.toolCalls) ? detail.toolCalls : [];
          const failing = calls.filter(
            (call): call is { tool?: unknown; isError?: unknown; resultPreview?: unknown } =>
              typeof call === 'object' && call !== null && !Array.isArray(call)
          );
          // Failed calls first — they are the evidence — then whatever else
          // fits, so a step that succeeded its calls and still failed reads.
          failing.sort(
            (left, right) => Number(right.isError === true) - Number(left.isError === true)
          );
          return {
            stepName: stepNameOf(snapshot, attempt.stepId),
            attempt: attempt.attempt,
            outcomeCode: attempt.outcomeCode,
            summary: clip(detail.summary, CLIP_SUMMARY),
            calls: failing.slice(0, MAX_SAMPLE_CALLS_PER_ATTEMPT).map((call) => ({
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
      stepName: row.step_name,
      errorKind: row.error_kind,
      outcomeCode: row.outcome_code,
      error: clip(row.error, CLIP_ERROR),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      toolCalls: row.tool_calls,
    })),
    steps,
    samples,
  };
}

/** The evidence as the prompt states it — one section per source. */
export function renderEvidence(evidence: OptimizationEvidence): string {
  const lines: string[] = [];
  const { stats } = evidence;
  lines.push(`Window: the last ${evidence.windowDays} days.`);
  lines.push(
    `Runs: ${stats.runs} finished (${stats.succeeded} succeeded, ${stats.failed} failed). ` +
      `Average ${stats.avgTokensPerRun} tokens per run (max ${stats.maxTokensPerRun}), ` +
      `${stats.avgAttemptsPerRun} step attempts per run.`
  );

  lines.push('', 'Token spend by step (average per attempt; share of all tokens in the window):');
  if (evidence.steps.length === 0) lines.push('- (no step attempts recorded in the window)');
  for (const step of evidence.steps) {
    lines.push(
      `- "${step.stepName}": ${step.attempts} attempts, ${step.failedAttempts} failed; ` +
        `${step.avgInputTokens} in / ${step.avgOutputTokens} out per attempt; ` +
        `${step.avgToolCalls} tool calls per attempt; ${step.tokenShare}% of tokens`
    );
  }

  lines.push('', 'Failures (newest first):');
  if (evidence.failures.length === 0) lines.push('- (none in the window)');
  for (const failure of evidence.failures) {
    const where = failure.stepName ? ` at "${failure.stepName}"` : '';
    const code = failure.outcomeCode ? ` [${failure.outcomeCode}]` : '';
    lines.push(
      `- ${failure.at.slice(0, 16).replace('T', ' ')} (${failure.triggerKind})${where}: ` +
        `${failure.errorKind ?? 'failed'}${code}` +
        (failure.error ? ` — ${failure.error}` : '') +
        ` (cost ${failure.inputTokens + failure.outputTokens} tokens, ${failure.toolCalls} tool calls)`
    );
  }

  if (evidence.samples.length > 0) {
    lines.push('', 'What the failed attempts said (recent runs, the failing steps only):');
    for (const sample of evidence.samples) {
      lines.push(
        `Run ${sample.at.slice(0, 16).replace('T', ' ')}: ${sample.errorKind ?? 'failed'}` +
          (sample.error ? ` — ${sample.error}` : '')
      );
      for (const attempt of sample.attempts) {
        lines.push(
          `  - "${attempt.stepName}" try ${attempt.attempt}` +
            (attempt.outcomeCode ? ` [${attempt.outcomeCode}]` : '') +
            (attempt.summary ? `: ${attempt.summary}` : '')
        );
        for (const call of attempt.calls) {
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
    steps: agent.steps,
    triggers: agent.triggers,
    guardrails: agent.guardrails,
    blockedTools: agent.blockedTools,
  });
  return [
    'You are reviewing a user-drafted automation ("agent") that runs as a sequence of steps, each an instruction to a model with at most one tool. The owner wants it to fail less and cost fewer tokens. You have its definition and its recent run history.',
    '',
    '=== DEFINITION ===',
    definition,
    '',
    '=== EVIDENCE ===',
    renderEvidence(evidence),
    '',
    '=== HOW THE ENGINE BEHAVES (take as given) ===',
    '- Steps run in order; a later step runs only if everything before it succeeded. An unhandled failure, a failure handled with "stop", or exhausted retries stops the whole run.',
    "- Every attempt of a step re-sends that step's instruction, the guardrails, the tool definitions it may call, and the results saved so far. Long instructions, wide tool access, many retries, and steps that save large results are what cost tokens.",
    "- A step's tool result is verified against the tool's declared success; a custom outcome condition is judged by the model over the result, which costs an extra reasoning pass.",
    '- Retries repeat the whole attempt. Corrective guidance on a retry line changes what the model does differently; without it a retry usually repeats the same mistake.',
    '- Approval pauses and questions to the owner are engine features, not problems.',
    '',
    '=== WHAT TO DO ===',
    'Find the REAL causes. Tie every finding to the evidence: name the step, quote the failure code or the number that shows it. Do not invent failures the evidence does not show, and do not raise concerns the engine already prevents. Prefer few, specific findings over many generic ones.',
    'Areas: "accuracy" (the agent does the wrong thing or stops when it should not: wrong tool, an instruction that promises work no step does, a missing outcome line, retries without corrective guidance, a condition the model keeps misjudging), "reliability" (external failures the agent could handle: rate limits, missing records, permission errors — add an outcome line, a retry with guidance, or a "keep going" choice), "tokens" (spend that buys nothing: repeated context, a step that could be one tool call, saved results far larger than the next step needs, unnecessary retries, an instruction that could be a third the length and say the same).',
    '',
    'Reply with JSON only, no code fences:',
    '{"summary": "...", "findings": [{"area": "accuracy|reliability|tokens", "severity": "high|medium|low", "step": "step name or null", "issue": "...", "fix": "...", "evidence": "..."}], "revisionBrief": "...", "expectedImpact": {"failures": "...", "tokens": "..."}}',
    'summary: 2-3 plain sentences for the owner — what is going wrong and what it is costing, no tool identifiers.',
    'findings: 0-8 entries, most important first. "issue" says what is wrong (one or two sentences); "fix" is the concrete edit (which step, what to change it to); "evidence" cites the numbers or failures it rests on.',
    'revisionBrief: instructions a drafting model can apply to revise the steps — write it as a numbered list of edits, each naming the step by its name as shown in the definition and saying exactly what to change (reworded instruction text, outcome lines to add with their action and guidance, tries to lower, results to save smaller, steps to merge or remove). Keep every step the edits do not mention exactly as it is. Null if nothing should change.',
    'expectedImpact: one sentence each on failures and on tokens, honest about uncertainty; null when the report does not address one.',
  ].join('\n');
}

export type OptimizeOutcome =
  | { report: OptimizationReport; usage: { inputTokens: number; outputTokens: number } }
  | { error: string; detail?: string };

/** The whole pass: evidence → prompt → the org's model → a parsed report. */
export async function optimizeAgent(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agent: StoredAgent,
  windowDays: number
): Promise<OptimizeOutcome> {
  const llmResult = await resolveAgentLlm(db, tenantId, agent.llmModelId);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization yet.' };
  }
  const llm = llmResult.val;

  const evidence = await gatherOptimizationEvidence(db, tenantId, ownerSubject, agent, windowDays);
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
    stepsVersion: agent.stepsVersion,
  };

  const startedAt = Date.now();
  const completion = await retryWithBackoff(
    () =>
      llm.provider.complete({
        system:
          'You are a careful reviewer of user-drafted automations. You reason from the evidence you are given, cite it, and reply with strict JSON.',
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
          tenantId,
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
      tenantId,
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
    tenantId,
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
  return { report, usage };
}
