/**
 * The run executor: claims a `{ runId }` job and drives the run to a
 * terminal state, one step at a time, one attempt at a time.
 *
 * The database is the engine's memory. Every attempt exists as an
 * agent_run_steps row BEFORE its LLM loop starts; the user's attempt
 * budget (≤ 5, the platform ceiling) is enforced by COUNTING those rows,
 * never by trusting the snapshot; `unique(run_id, step_id, attempt)` makes
 * a second executor of the same run fail loudly instead of acting twice.
 * A redelivered job therefore RESUMES: terminal runs complete idempotently,
 * an interrupted attempt is closed as failed, and execution picks up at
 * `current_step_id`.
 *
 * The model sees only the current step (prompt.ts). Its outcome claim is
 * checked against reality: a step whose primary tool only ever returned
 * errors cannot be declared a success.
 *
 * Failure classification order for choosing a FailureHandling row:
 * `_meta['renkei/outcome']` on the tool result → text heuristics on the
 * error → the model's declared code → 'other'.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DB, Json } from '@renkei/db';
import {
  findNodeById,
  flattenActionSteps,
  isAgentStepsDoc,
  isBranchStep,
  renderInstruction,
  toolSegments,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type BranchPath,
  type BranchStep,
  type FailureHandling,
} from '@renkei/agents';
import {
  resolveAgentLlm,
  type LlmContentBlock,
  type LlmMessage,
  type LlmToolDef,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import { getOrgSettings } from '@renkei/settings';
import type { McpClient, McpToolInfo, McpToolResult } from './mcp-client';
import { AgentMcpClient } from './mcp-client';
import { mintRunToken, revokeRunToken } from './token';
import {
  appendAgentMemory,
  readAgentMemory,
  renderAgentMemory,
  renderAgentKnowledgeNotes,
} from '@renkei/agents/memory';
import { recordAgentRunFailure } from '@renkei/agents/runs';
import {
  BRANCH_SYSTEM_PROMPT,
  buildAttemptMessages,
  buildBranchMessages,
  CHOOSE_PATH_DEF,
  CHOOSE_PATH_TOOL,
  FINISH_STEP_DEF,
  FINISH_STEP_TOOL,
  SYSTEM_PROMPT,
} from './prompt';
import { logger } from './logger';

const NORMAL_TOOL_CAP = 3;
const CORRECTIVE_TOOL_CAP = 10;
const MAX_LLM_TURNS = 10;
const PREVIEW_CHARS = 2_000;
const DETAIL_CHARS = 60_000;
const TOKEN_SLACK_SECONDS = 15 * 60;

export interface FinalizedRun {
  runId: string;
  tenantId: string;
  agentId: string;
  ownerSubject: string;
  /** 'stopped' = the run ended gracefully with nothing to do — not a failure. */
  status: 'succeeded' | 'failed' | 'stopped';
  errorKind: string | null;
  error: string | null;
  /** saveAs bindings accumulated over the run, for chained agents. */
  vars: Record<string, string>;
  /**
   * A deliberate silent stop: the run succeeded but asked for NO reply, no
   * notification, no chaining — "not relevant, do nothing" ends invisibly
   * everywhere except run history.
   */
  quiet: boolean;
}

export interface EngineDeps {
  db: Kysely<DB>;
  /** Base URL the worker reaches the web app on (RENKEI_WEB_INTERNAL_URL). */
  webBaseUrl: string;
  createMcpClient?: (tenantId: string, token: string, webBaseUrl: string) => McpClient;
  mintToken?: typeof mintRunToken;
  revokeToken?: typeof revokeRunToken;
  resolveLlm?: typeof resolveAgentLlm;
  /** Called once per terminal run — trigger fan-out and notifications hook. */
  onFinalized?: (run: FinalizedRun) => Promise<void>;
}

interface RunRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  owner_subject: string;
  steps_snapshot: Json;
  llm_model_id: string | null;
  initial_state: Json | null;
  status: string;
  current_step_id: string | null;
  started_at: Date | null;
}

interface AttemptRecord {
  step_id: string;
  attempt: number;
  status: string;
  detail: Json | null;
}

interface ToolCallRecord {
  tool: string;
  argsPreview: string;
  resultPreview: string;
  isError: boolean;
  durationMs: number;
}

interface AttemptOutcome {
  succeeded: boolean;
  /**
   * Set when finish_step declared the whole run over: 'done'/'quiet' from a
   * success's stop flags, 'nothing' from outcome 'nothing-to-do' — the step
   * judged the automation does not apply to this input at all.
   */
  stopRun?: 'done' | 'quiet' | 'nothing';
  outcome: 'tool_ok' | 'llm_declared' | 'tool_error' | 'llm_error' | 'guard';
  outcomeCode: string | null;
  summary: string;
  saveValue: string | null;
  /** A note finish_step asked to carry into future runs (agent memory). */
  remember: string | null;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number };
  unbound: string[];
  resolvedInstruction: string;
}

/** The run-scoped context blocks every attempt's prompt carries. */
interface RunContextText {
  memoryText: string;
  knowledgeText: string;
}

/** A run-level abort that retrying attempts cannot fix. */
class RunAbort extends Error {
  constructor(
    public readonly kind: string,
    message: string
  ) {
    super(message);
  }
}

/** Thrown to nack the queue job — transient, resume later, no attempt burned. */
class TransientFailure extends Error {}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function classifyErrorText(text: string): string {
  if (/not found|does not exist|no such|404/i.test(text)) return 'not-found';
  if (/forbidden|permission|unauthorized|access denied|401|403/i.test(text)) return 'no-permission';
  if (/invalid|required|rejected|malformed|400|422/i.test(text)) return 'invalid-input';
  if (/rate limit|timed? ?out|unavailable|overloaded|429|5\d\d/i.test(text)) {
    return 'service-unavailable';
  }
  return 'other';
}

function textOf(result: McpToolResult): string {
  return result.content
    .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

/** The failure code that selects a FailureHandling row. */
function classifyFailure(primaryResults: McpToolResult[], declaredCode: string | null): string {
  const lastError = [...primaryResults].reverse().find((result) => result.isError);
  if (lastError) {
    const metaCode = lastError.meta['renkei/outcome'];
    if (typeof metaCode === 'string' && metaCode) return metaCode;
    const heuristic = classifyErrorText(textOf(lastError));
    if (heuristic !== 'other') return heuristic;
  }
  return declaredCode ?? 'other';
}

function handlingFor(step: ActionStep, code: string): FailureHandling | undefined {
  return (
    step.failureHandling.find((handling) => handling.outcome === code) ??
    step.failureHandling.find((handling) => handling.outcome === 'other')
  );
}

function chooseArgsOf(input: unknown): { choice: 'yes' | 'no'; reason: string } | null {
  if (typeof input !== 'object' || input === null) return null;
  const args: { choice?: unknown; reason?: unknown } = input;
  if (args.choice !== 'yes' && args.choice !== 'no') return null;
  return { choice: args.choice, reason: typeof args.reason === 'string' ? args.reason : '' };
}

/**
 * One executable frame: a sibling list and the position within it. The
 * stack of frames IS the program counter — popping an exhausted frame
 * lands execution after the branch block that pushed it.
 */
interface Frame {
  nodes: AgentStepNode[];
  index: number;
}

/**
 * The frame stack that puts `startId` on top, derived purely from where the
 * id lives in the tree — ids are doc-unique, so the ancestor chain IS the
 * record of which paths the run took. Unknown/absent id → start at the top.
 */
function buildResumeStack(nodes: AgentStepNode[], startId: string | null): Frame[] {
  if (!startId) return [{ nodes, index: 0 }];
  const found = findNodeById(nodes, startId);
  if (!found) return [{ nodes, index: 0 }];
  const stack: Frame[] = [];
  let container = nodes;
  for (const ancestor of found.ancestors) {
    const branchIndex = container.indexOf(ancestor.branch);
    // Past the branch, so popping this frame continues AFTER the block.
    stack.push({ nodes: container, index: Math.max(0, branchIndex) + 1 });
    container = ancestor.path.steps;
  }
  stack.push({ nodes: found.siblings, index: found.index });
  return stack;
}

function finishArgsOf(input: unknown): {
  outcome: 'success' | 'failure' | 'nothing-to-do';
  code: string | null;
  summary: string;
  saveValue: string | null;
  stop: boolean;
  quiet: boolean;
  remember: string | null;
} | null {
  if (typeof input !== 'object' || input === null) return null;
  const args: {
    outcome?: unknown;
    code?: unknown;
    summary?: unknown;
    saveValue?: unknown;
    stop?: unknown;
    quiet?: unknown;
    remember?: unknown;
  } = input;
  if (
    args.outcome !== 'success' &&
    args.outcome !== 'failure' &&
    args.outcome !== 'nothing-to-do'
  ) {
    return null;
  }
  return {
    outcome: args.outcome,
    code: typeof args.code === 'string' ? args.code : null,
    summary: typeof args.summary === 'string' ? args.summary : '',
    saveValue: typeof args.saveValue === 'string' ? args.saveValue : null,
    stop: args.stop === true,
    quiet: args.quiet === true,
    remember:
      typeof args.remember === 'string' && args.remember.trim() ? args.remember.trim() : null,
  };
}

export function createAgentRunHandler(deps: EngineDeps) {
  const db = deps.db;
  const createClient =
    deps.createMcpClient ??
    ((tenantId: string, token: string, base: string) =>
      new AgentMcpClient(`${base.replace(/\/+$/, '')}/api/mcp/${tenantId}/mcp`, token));
  const mint = deps.mintToken ?? mintRunToken;
  const revoke = deps.revokeToken ?? revokeRunToken;
  const resolveLlm = deps.resolveLlm ?? resolveAgentLlm;

  return async function handleRun(message: { payload: Json }): Promise<void> {
    const payload: { runId?: unknown } =
      typeof message.payload === 'object' &&
      message.payload !== null &&
      !Array.isArray(message.payload)
        ? message.payload
        : {};
    if (typeof payload.runId !== 'string') {
      // A malformed pointer can never become valid; dead-letter via throw
      // would retry it, so log and complete instead.
      logger.error('agent job without runId; dropping', { component: 'worker-agents/engine' });
      return;
    }
    const runId = payload.runId;

    const run = await db
      .selectFrom('agent_runs')
      .select([
        'id',
        'tenant_id',
        'agent_id',
        'owner_subject',
        'steps_snapshot',
        'llm_model_id',
        'initial_state',
        'status',
        'current_step_id',
        'started_at',
      ])
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) {
      logger.warn('agent job for unknown run {runId}; dropping', {
        component: 'worker-agents/engine',
        runId,
      });
      return;
    }
    // Idempotent redelivery: a terminal run is simply acknowledged.
    if (
      run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'canceled' ||
      run.status === 'stopped'
    ) {
      return;
    }

    try {
      await executeRun(run);
    } catch (error) {
      if (error instanceof TransientFailure) throw error; // → queue backoff
      throw error;
    }
  };

  async function executeRun(run: RunRow): Promise<void> {
    const { tenant_id: tenantId, id: runId } = run;

    const settingsResult = await getOrgSettings(tenantId);
    if (!settingsResult.ok) throw new TransientFailure('org settings unavailable');
    const settings = settingsResult.val;

    if (!isAgentStepsDoc(run.steps_snapshot)) {
      await finalizeRun(run, 'failed', 'config', 'The saved steps could not be read.', {});
      return;
    }
    const nodes = run.steps_snapshot.steps;
    // Pre-order ordinal per node id — what agent_run_steps.step_index
    // records. On a linear doc this is the flat index, byte-for-byte the
    // old behavior; inside branches it stays monotone along any executed
    // sequence, so timeline ordering keeps working.
    const ordinals = new Map(walkSteps(nodes).map((entry) => [entry.node.id, entry.ordinal]));

    // The agent may have been disabled between enqueue and claim.
    const agentRow = await db
      .selectFrom('agents')
      .select(['enabled'])
      .where('id', '=', run.agent_id)
      .executeTakeFirst();
    if (!agentRow) {
      await finalizeRun(run, 'failed', 'config', 'The agent no longer exists.', {});
      return;
    }
    if (!agentRow.enabled && run.status === 'queued') {
      await db
        .updateTable('agent_runs')
        .set({ status: 'canceled', finished_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', runId)
        .execute();
      return;
    }

    const llmResult = await resolveLlm(db, tenantId, run.llm_model_id);
    if (!llmResult.ok) {
      const kind = llmResult.err.type === 'DB_ERROR' ? null : 'config';
      if (!kind) throw new TransientFailure('model config unavailable');
      await finalizeRun(
        run,
        'failed',
        kind,
        llmResult.err.message ?? 'No model is configured for this organization.',
        {}
      );
      return;
    }
    const llm = llmResult.val;

    const startedAt = run.started_at ?? new Date();
    if (run.status === 'queued') {
      await db
        .updateTable('agent_runs')
        .set({
          status: 'running',
          started_at: startedAt,
          llm_model_id: llm.modelConfigId,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', runId)
        .execute();
    }
    const deadline = startedAt.getTime() + settings.agentRunTimeoutMinutes * 60_000;

    const token = await mint(db, {
      tenantId,
      subject: run.owner_subject,
      agentId: run.agent_id,
      ttlSeconds: settings.agentRunTimeoutMinutes * 60 + TOKEN_SLACK_SECONDS,
    });

    try {
      const mcp = createClient(tenantId, token, deps.webBaseUrl);
      await mcp.initialize();
      const availableTools = await mcp.listTools();
      const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]));

      // Resume state: prior attempt rows rebuild position, budgets, and the
      // saveAs bindings recorded on succeeded attempts.
      const priorAttempts = await db
        .selectFrom('agent_run_steps')
        .select(['step_id', 'attempt', 'status', 'detail'])
        .where('run_id', '=', runId)
        .orderBy('attempt')
        .execute();
      const vars = await baseVariables(run);
      recoverSavedVars(nodes, priorAttempts, vars);

      // The agent's carried context: memory (earlier runs' breadcrumbs)
      // and its own knowledge notes, both bounded at render time — the
      // read-side budget is what keeps prompts safe however large either
      // store grows. Best-effort: an unreadable memory degrades the run to
      // amnesiac, it never fails it.
      const context = await loadRunContext(run);

      // Crash-resume rebuilds the frame stack from where current_step_id
      // sits in the tree; a fresh run starts one frame at the top.
      const stack = buildResumeStack(nodes, run.current_step_id);

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.index >= frame.nodes.length) {
          // This sibling list is done — resume the enclosing one, which is
          // already positioned after its branch block.
          stack.pop();
          continue;
        }
        const node = frame.nodes[frame.index];
        await db
          .updateTable('agent_runs')
          .set({ current_step_id: node.id, updated_at: sql`NOW()` })
          .where('id', '=', runId)
          .execute();

        if (isBranchStep(node)) {
          const decided = await evaluateBranch(
            run,
            node,
            llm,
            vars,
            context,
            deadline,
            settings.agentMaxStepAttempts,
            ordinals
          );
          if (decided.kind === 'fail') {
            await finalizeRun(run, 'failed', decided.errorKind, decided.error, vars);
            return;
          }
          // Advance past the branch FIRST, then descend — popping the path
          // frame later lands exactly after the block.
          frame.index += 1;
          stack.push({ nodes: decided.path.steps, index: 0 });
          continue;
        }

        const result = await executeStep(
          run,
          node,
          toolsByName,
          llm,
          mcp,
          vars,
          context,
          deadline,
          settings.agentMaxStepAttempts,
          ordinals
        );
        if (result.kind === 'advance') {
          frame.index += 1;
          continue;
        }
        if (result.kind === 'finish') {
          // A deliberate early success — configured on the step or declared
          // by the instruction's own "…and stop here".
          await finalizeRun(run, 'succeeded', null, null, vars, result.quiet);
          return;
        }
        if (result.kind === 'stop') {
          // The step judged the automation does not apply to this input (a
          // declared nothing-to-do, or a failure the owner marked benign) —
          // a graceful terminal: no error, and quiet so no notification and
          // no chained agents (nothing was done to chain from). The why is
          // on the step's attempt row in the run timeline.
          await finalizeRun(run, 'stopped', null, null, vars, true);
          return;
        }
        await finalizeRun(run, 'failed', result.errorKind, result.error, vars);
        return;
      }

      await finalizeRun(run, 'succeeded', null, null, vars);
    } finally {
      await revoke(db, token);
    }
  }

  /** Memory + knowledge notes, rendered and bounded; '' halves on failure. */
  async function loadRunContext(run: RunRow): Promise<RunContextText> {
    let memoryText = '';
    let knowledgeText = '';
    try {
      memoryText = renderAgentMemory(await readAgentMemory(db, run.tenant_id, run.agent_id));
    } catch (error) {
      logger.warn('agent memory unreadable for run {runId}: {error}', {
        component: 'worker-agents/engine',
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      knowledgeText = await renderAgentKnowledgeNotes(db, run.tenant_id, run.agent_id);
    } catch (error) {
      logger.warn('agent knowledge notes unreadable for run {runId}: {error}', {
        component: 'worker-agents/engine',
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { memoryText, knowledgeText };
  }

  /** Builtins + trigger.* from initial_state. */
  async function baseVariables(run: RunRow): Promise<Record<string, string>> {
    const vars: Record<string, string> = {
      today: new Date().toISOString().slice(0, 10),
    };
    const identity = await db
      .selectFrom('identities')
      .select(['email', 'display_name'])
      .where('tenant_id', '=', run.tenant_id)
      .where('subject', '=', run.owner_subject)
      .executeTakeFirst();
    if (identity?.display_name) vars['user.name'] = identity.display_name;
    if (identity?.email) vars['user.email'] = identity.email;

    if (
      typeof run.initial_state === 'object' &&
      run.initial_state !== null &&
      !Array.isArray(run.initial_state)
    ) {
      for (const [key, value] of Object.entries(run.initial_state)) {
        if (value === null || value === undefined) continue;
        vars[`trigger.${key}`] =
          typeof value === 'string' ? value : clip(JSON.stringify(value), PREVIEW_CHARS);
      }
    }
    return vars;
  }

  function recoverSavedVars(
    nodes: AgentStepNode[],
    prior: AttemptRecord[],
    vars: Record<string, string>
  ): void {
    const saveAsByStep = new Map(
      flattenActionSteps(nodes).flatMap((step) =>
        step.saveAs ? [[step.id, step.saveAs] as const] : []
      )
    );
    for (const attempt of prior) {
      if (attempt.status !== 'succeeded') continue;
      const name = saveAsByStep.get(attempt.step_id);
      if (!name) continue;
      const detail: { saveValue?: unknown } =
        typeof attempt.detail === 'object' &&
        attempt.detail !== null &&
        !Array.isArray(attempt.detail)
          ? attempt.detail
          : {};
      if (typeof detail.saveValue === 'string') vars[name] = detail.saveValue;
    }
  }

  async function executeStep(
    run: RunRow,
    step: ActionStep,
    toolsByName: Map<string, McpToolInfo>,
    llm: ResolvedLlm,
    mcp: McpClient,
    vars: Record<string, string>,
    context: RunContextText,
    deadline: number,
    orgAttemptCap: number,
    ordinals: Map<string, number>
  ): Promise<
    | { kind: 'advance' }
    | { kind: 'finish'; quiet: boolean }
    | { kind: 'stop'; reason: string }
    | { kind: 'fail'; errorKind: string; error: string }
  > {
    // Pre-flight: the step's tool must exist in the OWNER's live projection.
    // No LLM spend on a run that cannot work.
    if (step.tool && !toolsByName.has(step.tool)) {
      return {
        kind: 'fail',
        errorKind: 'config',
        error: `The skill "${step.tool}" is not available to this agent's owner right now.`,
      };
    }

    // Two ceilings, lower wins: the step's own setting and the ORG's cap —
    // a live setting, so lowering it bites existing agents without a
    // re-save. The org cap may exceed MAX_STEP_ATTEMPTS (that constant is
    // the default, not an absolute), which is why it is not min'd in here.
    const budget = Math.min(step.maxAttempts, Math.max(1, orgAttemptCap));
    let lastFailureSummary: string | undefined;
    let lastFailureCode: string | null = null;

    for (;;) {
      // Close an attempt a crashed worker left open, then recount.
      await db
        .updateTable('agent_run_steps')
        .set({
          status: 'failed',
          outcome: 'llm_error',
          outcome_code: 'other',
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('run_id', '=', run.id)
        .where('step_id', '=', step.id)
        .where('status', '=', 'running')
        .execute();

      const counted = await db
        .selectFrom('agent_run_steps')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('run_id', '=', run.id)
        .where('step_id', '=', step.id)
        .executeTakeFirst();
      const attemptsUsed = Number(counted?.count ?? 0);

      // Advance past a step that already succeeded (resume case).
      const succeeded = await db
        .selectFrom('agent_run_steps')
        .select('id')
        .where('run_id', '=', run.id)
        .where('step_id', '=', step.id)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      if (succeeded) return { kind: 'advance' };

      if (attemptsUsed >= budget) {
        return {
          kind: 'fail',
          errorKind: 'step_failed',
          error: `Step "${step.name}" failed after ${attemptsUsed} attempt${attemptsUsed === 1 ? '' : 's'}${lastFailureCode ? ` (${lastFailureCode})` : ''}.`,
        };
      }
      if (Date.now() > deadline) {
        return { kind: 'fail', errorKind: 'timeout', error: 'The run exceeded its time budget.' };
      }

      const attempt = attemptsUsed + 1;
      const matched = lastFailureCode === null ? undefined : handlingFor(step, lastFailureCode);
      const guidance = attempt > 1 ? matched?.guidance : undefined;

      const rowId = randomUUID();
      // The tripwire: a racing second executor violates the unique
      // constraint here and backs off via queue redelivery.
      try {
        await db
          .insertInto('agent_run_steps')
          .values({
            id: rowId,
            tenant_id: run.tenant_id,
            run_id: run.id,
            step_id: step.id,
            step_index: ordinals.get(step.id) ?? 0,
            attempt,
            status: 'running',
            started_at: sql`NOW()`,
          })
          .execute();
      } catch (error) {
        if (error instanceof Error && error.message.includes('agent_run_steps_attempt')) {
          throw new TransientFailure('another executor holds this run');
        }
        throw error;
      }

      let outcome: AttemptOutcome;
      try {
        outcome = await runAttempt(
          run,
          step,
          attempt,
          guidance,
          toolsByName,
          llm,
          mcp,
          vars,
          context
        );
      } catch (error) {
        if (error instanceof TransientFailure) {
          // No tool ran; void the attempt row so the user-visible budget is
          // untouched, and let the queue back off.
          await db.deleteFrom('agent_run_steps').where('id', '=', rowId).execute();
          throw error;
        }
        if (error instanceof RunAbort) {
          await db.deleteFrom('agent_run_steps').where('id', '=', rowId).execute();
          return { kind: 'fail', errorKind: error.kind, error: error.message };
        }
        throw error;
      }

      const detail = {
        resolvedInstruction: clip(outcome.resolvedInstruction, PREVIEW_CHARS),
        llmSummary: clip(outcome.summary, PREVIEW_CHARS),
        declaredOutcome:
          outcome.stopRun === 'nothing'
            ? 'nothing-to-do'
            : outcome.succeeded
              ? 'success'
              : 'failure',
        ...(outcome.saveValue !== null
          ? { saveValue: clip(outcome.saveValue, PREVIEW_CHARS) }
          : {}),
        ...(outcome.unbound.length > 0 ? { unboundVariables: outcome.unbound } : {}),
        ...(guidance
          ? { guidanceUsed: clip(renderInstruction(guidance, vars).text, PREVIEW_CHARS) }
          : {}),
        toolCalls: outcome.toolCalls,
        usage: outcome.usage,
      };
      const detailJson = clip(JSON.stringify(detail), DETAIL_CHARS);

      await db
        .updateTable('agent_run_steps')
        .set({
          status: outcome.succeeded ? 'succeeded' : 'failed',
          outcome: outcome.outcome,
          outcome_code: outcome.outcomeCode,
          tool_call_count: outcome.toolCalls.length,
          detail: detailJson,
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', rowId)
        .execute();

      if (outcome.remember) {
        // The step asked future runs to know something. Best-effort: a
        // memory write must never change this attempt's outcome.
        try {
          await appendAgentMemory(db, {
            tenantId: run.tenant_id,
            agentId: run.agent_id,
            content: outcome.remember,
            runId: run.id,
          });
        } catch (error) {
          logger.warn('memory append failed for run {runId}: {error}', {
            component: 'worker-agents/engine',
            runId: run.id,
            subject: run.owner_subject,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (outcome.succeeded) {
        // A 'nothing-to-do' declaration ends the run gracefully — its own
        // terminal, distinct from success, never a failure.
        if (outcome.stopRun === 'nothing') {
          return { kind: 'stop', reason: clip(outcome.summary, 300) };
        }
        if (step.saveAs && outcome.saveValue !== null) vars[step.saveAs] = outcome.saveValue;
        // A stop can be declared at runtime (the instruction's own "…and
        // stop here", via finish_step) or configured statically on the
        // step; the runtime declaration wins because it saw the condition.
        const staticStop =
          step.onSuccess === 'stop'
            ? 'done'
            : step.onSuccess === 'stop-quiet'
              ? 'quiet'
              : undefined;
        const stop = outcome.stopRun ?? staticStop;
        if (stop) return { kind: 'finish', quiet: stop === 'quiet' };
        return { kind: 'advance' };
      }

      lastFailureSummary = outcome.summary || 'The previous attempt failed.';
      lastFailureCode = outcome.outcomeCode ?? 'other';
      const handling = handlingFor(step, lastFailureCode);
      // The owner declared this outcome NOT an error ("ticket not found" is
      // sometimes just "nothing to do") — the same graceful terminal as a
      // declared nothing-to-do. The attempt row keeps its outcome code (the
      // timeline still says exactly what happened) but its STATUS becomes
      // 'stopped', matching the run: left 'failed', the timeline showed a
      // red Failed pill inside a nothing-to-do run, and the admin redaction
      // rule (step content is visible on failures, for troubleshooting)
      // exposed content of a step the owner explicitly declared benign.
      if (handling?.action === 'stop-quiet') {
        await db
          .updateTable('agent_run_steps')
          .set({ status: 'stopped', updated_at: sql`NOW()` })
          .where('id', '=', rowId)
          .execute();
        return { kind: 'stop', reason: clip(lastFailureSummary, 300) };
      }
      if (!handling || handling.action === 'exit') {
        return {
          kind: 'fail',
          errorKind: 'step_failed',
          error: `Step "${step.name}" stopped the agent (${lastFailureCode}): ${clip(lastFailureSummary, 300)}`,
        };
      }
      // action === 'retry' → loop; the budget check at the top decides
      // whether another attempt actually starts.
    }
  }

  /**
   * Decide a branch: a forced choose_path call against the condition — a
   * slimmed sibling of executeStep with the SAME bookkeeping (attempt rows
   * before LLM spend, budget by counting rows, unique-constraint tripwire,
   * deadline) and NO tools. Success closes the attempt row with outcome
   * 'path_chosen' and detail.chosenPathId, which is also what redelivery
   * reuses instead of asking the model twice.
   */
  async function evaluateBranch(
    run: RunRow,
    branch: BranchStep,
    llm: ResolvedLlm,
    vars: Record<string, string>,
    context: RunContextText,
    deadline: number,
    orgAttemptCap: number,
    ordinals: Map<string, number>
  ): Promise<
    { kind: 'path'; path: BranchPath } | { kind: 'fail'; errorKind: string; error: string }
  > {
    const pathById = (id: string | undefined): BranchPath | null => {
      if (branch.paths[0].id === id) return branch.paths[0];
      if (branch.paths[1].id === id) return branch.paths[1];
      return null;
    };

    const budget = Math.min(branch.maxAttempts, Math.max(1, orgAttemptCap));
    let lastFailureSummary: string | undefined;

    for (;;) {
      // Close an evaluation a crashed worker left open, then recount.
      await db
        .updateTable('agent_run_steps')
        .set({
          status: 'failed',
          outcome: 'llm_error',
          outcome_code: 'other',
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('run_id', '=', run.id)
        .where('step_id', '=', branch.id)
        .where('status', '=', 'running')
        .execute();

      // Redelivery/resume: an already-decided branch is not re-asked.
      const succeeded = await db
        .selectFrom('agent_run_steps')
        .select('detail')
        .where('run_id', '=', run.id)
        .where('step_id', '=', branch.id)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      if (succeeded) {
        const detail: { chosenPathId?: unknown } =
          typeof succeeded.detail === 'object' &&
          succeeded.detail !== null &&
          !Array.isArray(succeeded.detail)
            ? succeeded.detail
            : {};
        const chosen =
          typeof detail.chosenPathId === 'string' ? pathById(detail.chosenPathId) : null;
        if (chosen) return { kind: 'path', path: chosen };
        // Unreadable choice: fall through and re-evaluate under whatever
        // budget the counted rows leave.
      }

      const counted = await db
        .selectFrom('agent_run_steps')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('run_id', '=', run.id)
        .where('step_id', '=', branch.id)
        .executeTakeFirst();
      const attemptsUsed = Number(counted?.count ?? 0);

      if (attemptsUsed >= budget) {
        return {
          kind: 'fail',
          errorKind: 'step_failed',
          error: `Branch "${branch.name}" could not be decided after ${attemptsUsed} attempt${attemptsUsed === 1 ? '' : 's'}${lastFailureSummary ? `: ${clip(lastFailureSummary, 300)}` : '.'}`,
        };
      }
      if (Date.now() > deadline) {
        return { kind: 'fail', errorKind: 'timeout', error: 'The run exceeded its time budget.' };
      }

      const attempt = attemptsUsed + 1;
      const rowId = randomUUID();
      try {
        await db
          .insertInto('agent_run_steps')
          .values({
            id: rowId,
            tenant_id: run.tenant_id,
            run_id: run.id,
            step_id: branch.id,
            step_index: ordinals.get(branch.id) ?? 0,
            attempt,
            status: 'running',
            started_at: sql`NOW()`,
          })
          .execute();
      } catch (error) {
        if (error instanceof Error && error.message.includes('agent_run_steps_attempt')) {
          throw new TransientFailure('another executor holds this run');
        }
        throw error;
      }

      const built = buildBranchMessages({
        branch,
        variables: vars,
        attempt,
        ...(lastFailureSummary ? { previousFailure: lastFailureSummary } : {}),
        ...(context.memoryText ? { memoryText: context.memoryText } : {}),
        ...(context.knowledgeText ? { knowledgeText: context.knowledgeText } : {}),
      });
      const resolvedInstruction = renderInstruction(branch.condition, vars).text;
      const messages: LlmMessage[] = [...built.messages];
      const usage = { inputTokens: 0, outputTokens: 0 };
      let failureSummary = 'The model never chose a path.';

      let decidedPath: BranchPath | null = null;
      let decidedReason = '';
      // A short turn cap: forced choose_path should answer immediately; one
      // nudge covers a model that answered in prose first.
      for (let turn = 0; turn < 3 && !decidedPath; turn += 1) {
        const completion = await llm.provider.complete({
          system: BRANCH_SYSTEM_PROMPT,
          messages,
          tools: [CHOOSE_PATH_DEF],
          toolChoice: { name: CHOOSE_PATH_TOOL },
          maxTokens: llm.maxOutputTokens,
          ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
        });
        if (!completion.ok) {
          const kind = completion.err.type;
          if (kind === 'auth') {
            await db.deleteFrom('agent_run_steps').where('id', '=', rowId).execute();
            return {
              kind: 'fail',
              errorKind: 'llm_auth',
              error: 'The model rejected the API key.',
            };
          }
          if (kind === 'invalid_request') {
            await db.deleteFrom('agent_run_steps').where('id', '=', rowId).execute();
            return {
              kind: 'fail',
              errorKind: 'llm_error',
              error: completion.err.message ?? 'The model rejected the request.',
            };
          }
          if (kind === 'rate_limit' || kind === 'overloaded' || kind === 'network') {
            // Nothing spent — void the row and let the queue back off.
            await db.deleteFrom('agent_run_steps').where('id', '=', rowId).execute();
            throw new TransientFailure(`model ${kind}`);
          }
          failureSummary = completion.err.message ?? `The model failed (${kind}).`;
          break;
        }

        usage.inputTokens += completion.val.usage.inputTokens;
        usage.outputTokens += completion.val.usage.outputTokens;
        messages.push({ role: 'assistant', content: completion.val.content });

        const toolUses = completion.val.content.filter(
          (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> =>
            block.type === 'tool_use'
        );
        const chooseUse = toolUses.find((use) => use.name === CHOOSE_PATH_TOOL);
        const choice = chooseUse ? chooseArgsOf(chooseUse.input) : null;
        if (chooseUse && choice) {
          decidedPath = choice.choice === 'yes' ? branch.paths[0] : branch.paths[1];
          decidedReason = choice.reason;
          break;
        }
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Call choose_path exactly once with {choice: "yes" | "no", reason}.',
            },
          ],
        });
      }

      if (decidedPath) {
        const detail = {
          resolvedInstruction: clip(resolvedInstruction, PREVIEW_CHARS),
          llmSummary: clip(decidedReason, PREVIEW_CHARS),
          declaredOutcome: 'success',
          chosenPathId: decidedPath.id,
          chosenPathName: decidedPath.name,
          ...(built.unbound.length > 0 ? { unboundVariables: built.unbound } : {}),
          usage,
        };
        await db
          .updateTable('agent_run_steps')
          .set({
            status: 'succeeded',
            outcome: 'path_chosen',
            outcome_code: null,
            tool_call_count: 0,
            detail: clip(JSON.stringify(detail), DETAIL_CHARS),
            finished_at: sql`NOW()`,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', rowId)
          .execute();
        return { kind: 'path', path: decidedPath };
      }

      // The attempt failed to produce a choice — close it and let the loop
      // retry until the budget runs out.
      lastFailureSummary = failureSummary;
      const detail = {
        resolvedInstruction: clip(resolvedInstruction, PREVIEW_CHARS),
        llmSummary: clip(failureSummary, PREVIEW_CHARS),
        declaredOutcome: 'failure',
        usage,
      };
      await db
        .updateTable('agent_run_steps')
        .set({
          status: 'failed',
          outcome: 'llm_error',
          outcome_code: 'other',
          tool_call_count: 0,
          detail: clip(JSON.stringify(detail), DETAIL_CHARS),
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', rowId)
        .execute();
    }
  }

  async function runAttempt(
    run: RunRow,
    step: ActionStep,
    attempt: number,
    guidance: FailureHandling['guidance'],
    toolsByName: Map<string, McpToolInfo>,
    llm: ResolvedLlm,
    mcp: McpClient,
    vars: Record<string, string>,
    context: RunContextText
  ): Promise<AttemptOutcome> {
    const guidanceText = guidance ? renderInstruction(guidance, vars).text : undefined;
    const previousFailure = attempt > 1 ? await lastFailureText(run.id, step.id) : undefined;
    const toolCap = attempt > 1 ? CORRECTIVE_TOOL_CAP : NORMAL_TOOL_CAP;
    const built = buildAttemptMessages({
      step,
      attempt,
      variables: vars,
      toolBudget: toolCap,
      guidanceText,
      previousFailure,
      ...(context.memoryText ? { memoryText: context.memoryText } : {}),
      ...(context.knowledgeText ? { knowledgeText: context.knowledgeText } : {}),
    });

    // The step's one tool, plus (on corrective attempts) the guidance's
    // chips — the deliberately laxer set for fixing a failure.
    const offered: LlmToolDef[] = [FINISH_STEP_DEF];
    const primaryTool = step.tool;
    const offeredNames = new Set<string>([FINISH_STEP_TOOL]);
    const offer = (name: string) => {
      const info = toolsByName.get(name);
      if (!info || offeredNames.has(name)) return;
      offeredNames.add(name);
      offered.push({
        name: info.name,
        description: info.description,
        inputSchema: info.inputSchema,
      });
    };
    if (primaryTool) offer(primaryTool);
    if (attempt > 1 && guidance) for (const name of toolSegments(guidance)) offer(name);

    const messages: LlmMessage[] = [...built.messages];
    const toolCalls: ToolCallRecord[] = [];
    // Once the budget is spent the conversation narrows to finish_step only:
    // the model generally holds enough to answer, and "declare from what you
    // have seen" turns exhaustion into an honest outcome the step's failure
    // handling can route, where insta-failing produced an unroutable 'other'.
    let budgetExhausted = false;
    const primaryResults: McpToolResult[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const resolvedInstruction = renderInstruction(step.instruction, vars).text;

    const base = {
      toolCalls,
      usage,
      unbound: built.unbound,
      resolvedInstruction,
      // Only a finish_step call can ask to remember; error paths carry null.
      remember: null,
    };

    for (let turn = 0; turn < MAX_LLM_TURNS; turn += 1) {
      const completion = await llm.provider.complete({
        system: SYSTEM_PROMPT,
        messages,
        tools: budgetExhausted ? [FINISH_STEP_DEF] : offered,
        toolChoice: budgetExhausted ? { name: FINISH_STEP_TOOL } : 'any',
        maxTokens: llm.maxOutputTokens,
        ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
      });
      if (!completion.ok) {
        const kind = completion.err.type;
        if (kind === 'auth') throw new RunAbort('llm_auth', 'The model rejected the API key.');
        if (kind === 'invalid_request') {
          throw new RunAbort(
            'llm_error',
            completion.err.message ?? 'The model rejected the request.'
          );
        }
        if (kind === 'rate_limit' || kind === 'overloaded' || kind === 'network') {
          if (toolCalls.length === 0) throw new TransientFailure(`model ${kind}`);
          return {
            ...base,
            succeeded: false,
            outcome: 'llm_error',
            outcomeCode: 'service-unavailable',
            summary: `The model became unavailable mid-attempt (${kind}).`,
            saveValue: null,
          };
        }
        return {
          ...base,
          succeeded: false,
          outcome: 'llm_error',
          outcomeCode: 'other',
          summary: completion.err.message ?? `The model failed (${kind}).`,
          saveValue: null,
        };
      }

      usage.inputTokens += completion.val.usage.inputTokens;
      usage.outputTokens += completion.val.usage.outputTokens;
      messages.push({ role: 'assistant', content: completion.val.content });

      const toolUses = completion.val.content.filter(
        (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use'
      );
      if (toolUses.length === 0) {
        // No tool call and no finish: nudge once via the loop; the turn cap
        // bounds a model that never converges.
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Call finish_step with the outcome, or use the provided tool to do the work.',
            },
          ],
        });
        continue;
      }

      const results: LlmContentBlock[] = [];
      for (const use of toolUses) {
        if (use.name === FINISH_STEP_TOOL) {
          const finish = finishArgsOf(use.input);
          if (!finish) {
            results.push({
              type: 'tool_result',
              toolUseId: use.id,
              content: 'finish_step needs {outcome, summary}.',
              isError: true,
            });
            continue;
          }
          return decideOutcome(step, finish, primaryResults, base);
        }

        if (!offeredNames.has(use.name)) {
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: `The tool "${use.name}" is not available in this step.`,
            isError: true,
          });
          continue;
        }
        if (toolCalls.length >= toolCap) {
          // Out of budget — but the model has context worth a verdict.
          // Refuse the call and force finish_step on the next turn instead
          // of failing the attempt outright: exhaustion should end in a
          // declared outcome ('success' when the intent is met, a coded
          // failure when it clearly is not), which the step's failure
          // handling can route — where a guard failure routed nowhere.
          budgetExhausted = true;
          // Same-tool repetition usually means iterating items one call at a
          // time — the fix is a bulk tool in the step, not more budget.
          const repetitive =
            toolCalls.length > 1 && toolCalls.every((call) => call.tool === use.name);
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content:
              `Tool budget spent (${toolCap} calls this attempt) — this call was not made. ` +
              'Call finish_step now: declare success if what you already found satisfies the ' +
              'step, "nothing-to-do" if the automation turned out not to apply to this input, ' +
              'or failure with the best-matching code if it clearly does not.' +
              (repetitive
                ? ` Note: every call this attempt was ${use.name} — if you were covering many ` +
                  'items one at a time, say so in finish_step: the step should use a bulk ' +
                  'variant of the tool (or one search covering all items) instead.'
                : ''),
            isError: true,
          });
          continue;
        }

        const args =
          typeof use.input === 'object' && use.input !== null && !Array.isArray(use.input)
            ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
              (use.input as Record<string, unknown>)
            : {};
        const startedAt = Date.now();
        let result: McpToolResult;
        try {
          result = await mcp.callTool(use.name, args);
        } catch (error) {
          result = {
            content: [
              {
                type: 'text',
                text: `The tool could not be reached: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
            meta: {},
          };
        }
        const durationMs = Date.now() - startedAt;
        toolCalls.push({
          tool: use.name,
          argsPreview: clip(JSON.stringify(args), PREVIEW_CHARS),
          resultPreview: clip(textOf(result), PREVIEW_CHARS),
          isError: result.isError,
          durationMs,
        });
        if (use.name === primaryTool) primaryResults.push(result);
        results.push({
          type: 'tool_result',
          toolUseId: use.id,
          content: clip(textOf(result), PREVIEW_CHARS * 4),
          ...(result.isError ? { isError: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    return {
      ...base,
      succeeded: false,
      outcome: 'llm_error',
      outcomeCode: 'other',
      summary: 'The model never declared an outcome for this step.',
      saveValue: null,
    };
  }

  function decideOutcome(
    step: ActionStep,
    finish: {
      outcome: 'success' | 'failure' | 'nothing-to-do';
      code: string | null;
      summary: string;
      saveValue: string | null;
      stop: boolean;
      quiet: boolean;
      remember: string | null;
    },
    primaryResults: McpToolResult[],
    base: Pick<
      AttemptOutcome,
      'toolCalls' | 'usage' | 'unbound' | 'resolvedInstruction' | 'remember'
    >
  ): AttemptOutcome {
    if (finish.outcome === 'nothing-to-do') {
      // The step judged the automation does not apply to this input — a
      // judgment call, not an error, so the attempt records as succeeded
      // (its summary carries the why) and the run ends gracefully.
      return {
        ...base,
        succeeded: true,
        stopRun: 'nothing',
        outcome: primaryResults.length > 0 ? 'tool_ok' : 'llm_declared',
        outcomeCode: null,
        summary: finish.summary,
        saveValue: null,
        remember: finish.remember,
      };
    }
    if (finish.outcome === 'success') {
      // Reality check: a declared success over a primary tool that only ever
      // errored is recorded as the failure it is.
      const everyPrimaryErrored =
        step.tool !== null &&
        primaryResults.length > 0 &&
        primaryResults.every((result) => result.isError);
      if (everyPrimaryErrored) {
        return {
          ...base,
          succeeded: false,
          outcome: 'tool_error',
          outcomeCode: classifyFailure(primaryResults, finish.code),
          summary: finish.summary || 'The tool reported errors on every call.',
          saveValue: null,
          remember: finish.remember,
        };
      }
      return {
        ...base,
        succeeded: true,
        ...(finish.stop ? { stopRun: finish.quiet ? 'quiet' : 'done' } : {}),
        outcome: primaryResults.length > 0 ? 'tool_ok' : 'llm_declared',
        outcomeCode: null,
        summary: finish.summary,
        saveValue: finish.saveValue,
        remember: finish.remember,
      };
    }
    return {
      ...base,
      succeeded: false,
      outcome: primaryResults.some((result) => result.isError) ? 'tool_error' : 'llm_declared',
      outcomeCode: classifyFailure(primaryResults, finish.code),
      summary: finish.summary,
      saveValue: null,
      // A declared failure may still be worth remembering ("ticket X is
      // locked, skip it") — the model asked, keep it.
      remember: finish.remember,
    };
  }

  async function lastFailureText(runId: string, stepId: string): Promise<string | undefined> {
    const row = await db
      .selectFrom('agent_run_steps')
      .select('detail')
      .where('run_id', '=', runId)
      .where('step_id', '=', stepId)
      .where('status', '=', 'failed')
      .orderBy('attempt', 'desc')
      .limit(1)
      .executeTakeFirst();
    const detail: { llmSummary?: unknown } =
      typeof row?.detail === 'object' && row.detail !== null && !Array.isArray(row.detail)
        ? row.detail
        : {};
    return typeof detail.llmSummary === 'string' ? detail.llmSummary : undefined;
  }

  async function finalizeRun(
    run: RunRow,
    status: 'succeeded' | 'failed' | 'stopped',
    errorKind: string | null,
    error: string | null,
    vars: Record<string, string>,
    quiet = false
  ): Promise<void> {
    await db
      .updateTable('agent_runs')
      .set({
        status,
        error_kind: errorKind,
        error,
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', run.id)
      .execute();
    logger.info('run {runId} finished: {status}', {
      component: 'worker-agents/engine',
      runId: run.id,
      tenantId: run.tenant_id,
      agentId: run.agent_id,
      // The agent's OWNER — agent activity in the logs attributes to the
      // person whose authority the run borrowed.
      subject: run.owner_subject,
      status,
      errorKind: errorKind ?? undefined,
    });
    if (status === 'failed') {
      // The durable failure tally the oversight page buckets by period —
      // best effort, same as the run tally at creation.
      const tally = await recordAgentRunFailure(db, run.tenant_id, run.agent_id);
      if (!tally.ok) {
        logger.warn('failure tally not recorded for run {runId}', {
          component: 'worker-agents/engine',
          runId: run.id,
          tenantId: run.tenant_id,
          agentId: run.agent_id,
        });
      }
    }
    // The automatic breadcrumb — what makes "did I already handle this?"
    // answerable even when no step remembered anything explicitly. Carries
    // the trigger's identifying vars (messageId etc.), never bodies.
    try {
      const idsOfInterest = [
        'trigger.messageId',
        'trigger.roomId',
        'trigger.from',
        'trigger.sender',
        'trigger.subject',
        'trigger.scheduledFor',
      ];
      const idText = idsOfInterest
        .filter((key) => vars[key])
        .map((key) => `${key.slice('trigger.'.length)}=${clip(vars[key], 120)}`)
        .join(', ');
      await appendAgentMemory(db, {
        tenantId: run.tenant_id,
        agentId: run.agent_id,
        content: `Run ${status}${idText ? ` (${idText})` : ''}${error ? ` — ${clip(error, 160)}` : ''}`,
        runId: run.id,
      });
    } catch (memoryError) {
      logger.warn('finalize memory append failed for run {runId}: {error}', {
        component: 'worker-agents/engine',
        runId: run.id,
        subject: run.owner_subject,
        error: memoryError instanceof Error ? memoryError.message : String(memoryError),
      });
    }
    if (deps.onFinalized) {
      try {
        await deps.onFinalized({
          runId: run.id,
          tenantId: run.tenant_id,
          agentId: run.agent_id,
          ownerSubject: run.owner_subject,
          status,
          errorKind,
          error,
          vars,
          quiet,
        });
      } catch (hookError) {
        // Fan-out and notification failures must not un-finish the run.
        logger.error('finalize hook failed for run {runId}: {error}', {
          component: 'worker-agents/engine',
          runId: run.id,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
      }
    }
  }
}
