/**
 * The run executor: claims a `{ runId }` job and lets the agent work.
 *
 * An agent is instructions and tools (@renkei/agents' definition.ts). A
 * run is ONE conversation: the system prompt carries the frame, the
 * owner's guardrails, the instructions, knowledge and memory; the opening
 * message carries this run's input; then the model calls tools, reads
 * results, retries when something does not work, and ends with
 * finish_run. There is no plan for the engine to walk — what it enforces
 * is the boundary around the agent's autonomy:
 *
 *  - ACTIVE TIME: the org's agentRunTimeoutMinutes, counted only while
 *    the agent holds control (`agent_runs.active_ms`). A wait on a person
 *    — a staged batch awaiting acceptance, a question awaiting an answer —
 *    and the batch's own execution stop the clock; it resumes when the
 *    run is handed back.
 *  - TOOL CALLS: the org's agentRunToolCallBudget, counted from the turn
 *    rows (every real tool call, and each staged action), never from an
 *    in-memory counter that could drift. Built-ins are free.
 *  - NO DIRECT WRITES: the agent's own MCP token is minted with its READ
 *    tools only. Every tool that changes something is staged with
 *    stage_actions into an `agent_action_batches` row, accepted by a
 *    person (or by auto-accept, where the org allows it), and run by the
 *    separate executor (actions.ts) under a token of its own; the agent
 *    reads each outcome when control comes back.
 *
 * The database is the engine's memory. Each model turn is an
 * agent_run_steps row (step_id 'turn', attempt = turn number) written
 * BEFORE the model is called, updated as each tool result lands, and
 * sealed under the owner's automation key (turn-detail.ts). A redelivered
 * job — a crash, a deploy, a wake after a pause — rebuilds the
 * conversation from the rows and carries on from exactly where it was;
 * `unique(run_id, step_id, iteration, attempt)` makes a second executor of
 * the same run fail loudly instead of acting twice.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { describeActor as describeActorRaw } from '@renkei/db';
import type { DB, Json } from '@renkei/db';
import {
  APPROVAL_DEFAULT_TIMEOUT_HOURS,
  BUILTIN_VARIABLES,
  actApprovalReason,
  batchReportForAgent,
  friendlyToolName,
  isExternallyTriggered,
  mergeOpenedDetail,
  parseAgentDefinition,
  askedQuestionsOf,
  answersForAgent,
  RUN_COMPACTION_SYSTEM,
  RUN_KEEP_RECENT_TURNS,
  RUN_SUMMARY_MAX_CHARS,
  foldBatches,
  foldRequestText,
  summaryOpening,
  parseStagedActions,
  parseStoredActions,
  parseStoredResults,
  resolveTime,
  weekdayOf,
  sealedDetailOf,
  splitDetailForSealing,
  TIME_UNITS,
  type ActionBatchStatus,
  type AgentDefinition,
  type FormNode,
  type ResolveTimeRequest,
  type StagedAction,
  type TimeUnit,
} from '@renkei/agents';
import {
  ASK_PERSON_DEF,
  ASK_PERSON_TOOL,
  FINISH_RUN_DEF,
  FINISH_RUN_TOOL,
  REMEMBER_DEF,
  REMEMBER_TOOL,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_TOOL_CALLS,
  MAX_SUB_AGENTS_PER_RUN,
  MAX_SUB_AGENT_TURNS,
  SPAWN_AGENT_DEF,
  SPAWN_AGENT_TOOL,
  SUB_AGENT_REPORT_CHARS,
  RESOLVE_TIME_DEF,
  RESOLVE_TIME_TOOL,
  RUN_RESULT_CHARS,
  STAGE_ACTIONS_TOOL,
  TOOL_RESULT_CHARS,
  budgetLine,
  buildRunOpening,
  buildStageActionsDef,
  resumeMessage,
  runSystemPrompt,
  spawnArgsOf,
  subAgentSystemPrompt,
  untrustedBlock,
  type RunLimits,
} from '@renkei/agents/run-prompts';
import {
  resolveAgentLlm,
  contextWindowOfLlm,
  fitMessages,
  messagesChars,
  transcriptBudgetChars,
  maskCredentialHeaders,
  phiCoveredModelRefusal,
  wireRequestCauseOf,
  type LlmContentBlock,
  type LlmMessage,
  type LlmToolDef,
  type LlmUsage,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import { getOrgSettings, getPublicBaseUrl } from '@renkei/settings';
import { toolKindOf } from '@renkei/tool-outcomes';
import {
  NOTIFIER_TOOLS,
  notifierFor,
  notificationDeliverer,
  writeNotificationRow,
  type Notifier,
} from './notifications';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { delegateClient } from '@renkei/delegate-client';
import type { QueueProducer } from '@renkei/queue';
import type { McpClient, McpToolInfo, McpToolResult } from './mcp-client';
import { MessageReleased } from '@renkei/worker-loop';
import { AgentMcpClient } from './mcp-client';
import { mintRunToken, revokeRunToken } from './token';
import {
  appendAgentMemory,
  readAgentMemory,
  renderAgentMemory,
  renderAgentKnowledgeNotes,
} from '@renkei/agents/memory';
import { recordAgentRunOutcome, recordLlmCall } from '@renkei/agents/runs';
import { logger, secure } from './logger';

/** The step_id every turn row carries: a run has turns, not steps. */
export const TURN_STEP_ID = 'turn';
/**
 * The per-field cap on what a turn row keeps for the timeline: previews of
 * tool arguments and results. A display bound only — what the model reads
 * is bounded by TOOL_RESULT_CHARS.
 */
const PREVIEW_CHARS = 2_000;
/** A sub-agent's system prompt and tool list, generously: its budget's fixed part. */
const SUB_AGENT_FIXED_CHARS = 60_000;
const TOKEN_SLACK_SECONDS = 15 * 60;
/** Parents walked to find a chained run's root trigger — past any org's chain depth. */
const MAX_CHAIN_WALK = 10;
/** Model turns in a row that call no tool before the run is ended as stuck. */
const MAX_IDLE_TURNS = 3;
/** What a turn opens with after a reply that called no tool. */
const IDLE_NUDGE =
  'Use your tools to make progress, stage the changes that are needed, or call finish_run if you are done.';
/** The knowledge tool a run is given whenever its agent keeps notes. */
const KNOWLEDGE_TOOL = 'agent_knowledge_list';

export interface FinalizedRun {
  runId: string;
  agentId: string;
  ownerSubject: string;
  /**
   * 'stopped' = the agent found nothing to do — not a failure.
   * 'canceled' = someone asked it to stop; always carries `quiet: true`.
   */
  status: 'succeeded' | 'failed' | 'stopped' | 'canceled';
  errorKind: string | null;
  error: string | null;
  /** What the run hands a chained agent: its summary and result. */
  vars: Record<string, string>;
  /**
   * A deliberate silent stop: no notification, no chaining — "not
   * relevant, do nothing" ends invisibly everywhere except run history.
   */
  quiet: boolean;
}

export interface EngineDeps {
  db: Kysely<DB>;
  /** Base URL the worker reaches the web app on (RENKEI_WEB_INTERNAL_URL). */
  webBaseUrl: string;
  /** Where accepted batches go for the action executor (actions.ts). */
  actionsProducer: QueueProducer;
  createMcpClient?: (
    token: string,
    webBaseUrl: string,
    /** The run the client acts for — stamped on each call for the PHI access trail. */
    runId?: string
  ) => McpClient;
  mintToken?: typeof mintRunToken;
  revokeToken?: typeof revokeRunToken;
  resolveLlm?: typeof resolveAgentLlm;
  /** Called once per terminal run — chaining and the failure event. */
  onFinalized?: (run: FinalizedRun) => Promise<void>;
  /**
   * Whether this process is shutting down. Polled at every checkpoint —
   * before a model call and before a tool call — and true ends the run's
   * execution here, to be resumed elsewhere: see ExecutorStopping.
   */
  stopRequested?: () => boolean;
  /** The clock, for tests. */
  now?: () => number;
}

interface RunRow {
  id: string;
  agent_id: string;
  owner_subject: string;
  definition_snapshot: Json | null;
  llm_model_id: string | null;
  initial_state: Json | null;
  status: string;
  started_at: Date | null;
  waiting_until: Date | null;
  cancel_requested_at: Date | null;
  resumed_at: Date | null;
  resume_guidance: string | null;
  resume_failure: string | null;
  /** Why the run stopped or waits; 'needs-sign-in' marks a run parked for its owner's key. */
  error_kind: string | null;
  /** What started the run: 'event' | 'schedule' | 'agent' | 'api' | 'manual' (runs.ts). */
  trigger_kind: string;
  parent_run_id: string | null;
  active_ms: string | number;
}

/** One tool call as the timeline shows it. */
interface ToolCallRecord {
  tool: string;
  argsPreview: string;
  resultPreview: string;
  /** The full length of the result text, so a reader can tell what the preview cut. */
  resultChars?: number;
  isError: boolean;
  durationMs: number;
  /** Whether the call read or changed something, as the gateway stamped it. */
  kind?: 'read' | 'act';
  /** A built-in, answered in-process and not billed. */
  free?: boolean;
  /** stage_actions: how many actions it proposed (each billed once). */
  staged?: number;
  /**
   * The tool_use this answers. The turn's sealed `results` hold the full
   * result under the same id, so the run page shows all of it rather than
   * the preview. Absent on a sub-agent's calls, whose results are not kept.
   */
  toolUseId?: string;
}

/** One model call, as the timeline reads it. */
interface ModelCallRecord {
  durationMs: number;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
}

type ToolUseBlock = Extract<LlmContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<LlmContentBlock, { type: 'tool_result' }>;

/** What a turn is parked on. */
type Pause =
  | { kind: 'actions'; toolUseId: string; batchId: string }
  | {
      kind: 'question';
      toolUseId: string;
      message: string;
      form: FormNode[];
      timeoutHours?: number;
    };

/** A turn row's detail, opened. */
interface TurnDetail {
  opening?: string;
  assistant?: LlmContentBlock[];
  results?: ToolResultBlock[];
  /** The tool_use the executor was inside when it last wrote — its outcome is unknown. */
  inFlight?: string;
  pause?: Pause;
  finish?: 'done' | 'nothing_to_do' | 'failed';
  llmSummary?: string;
  result?: string;
  quiet?: boolean;
  toolCalls?: ToolCallRecord[];
  modelCalls?: ModelCallRecord[];
  usage?: UsageTotals;
  /**
   * Made on this turn when the conversation outgrew the model: the turns
   * up to `through` folded into `summary` (run-compaction.ts). Every later
   * call is sent the run's opening, the summary, then the turns after.
   */
  compaction?: { summary: string; through: number };
}

interface TurnRow {
  id: string;
  attempt: number;
  status: string;
  created_at: Date;
  tool_call_count: number;
  detail: TurnDetail;
}

class RunAbort extends Error {
  constructor(
    public readonly kind: string,
    message: string
  ) {
    super(message);
  }
}

/** The queue retries this one: nothing about the run is wrong. */
class TransientFailure extends Error {}

/**
 * Thrown at a checkpoint when this process has been told to stop: the run
 * stays `running`, its turn row as last written, and the job goes back to
 * the queue untouched (worker-loop's MessageReleased) for the next
 * executor to continue from the same point.
 */
class ExecutorStopping extends Error {}

/** A cancel click landed while the run was working. */
class RunCanceled extends Error {}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/**
 * The clip a tool result gets on its way to the model. The marker states
 * the loss, so a model knows the list it is reading is partial and can
 * page or filter.
 */
function clipForModel(text: string): string {
  if (text.length <= TOOL_RESULT_CHARS) return text;
  const dropped = text.length - TOOL_RESULT_CHARS;
  return `${text.slice(0, TOOL_RESULT_CHARS)}\n… [truncated: ${dropped} more characters were cut to fit; the result is incomplete — narrow the query or page the results to see the rest]`;
}

/**
 * A sub-agent's report goes to its parent whole; only one past the model
 * result limit is cut, and the cut is stated so the parent can tell.
 */
function clipSubAgentReport(text: string): string {
  if (text.length <= SUB_AGENT_REPORT_CHARS) return text;
  const dropped = text.length - SUB_AGENT_REPORT_CHARS;
  return `${text.slice(0, SUB_AGENT_REPORT_CHARS)}\n… [REPORT TRUNCATED: ${dropped} more characters were cut because the report was unusually long; what follows the cut is lost — give the sub-agent a narrower task if you need it]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argsOf(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
  };
}

function addUsage(totals: UsageTotals, usage: LlmUsage | UsageTotals): void {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  if (typeof usage.cacheReadInputTokens === 'number') {
    totals.cacheReadInputTokens = (totals.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
  }
  if (typeof usage.cacheWriteInputTokens === 'number') {
    totals.cacheWriteInputTokens =
      (totals.cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
  }
}

function textOf(result: McpToolResult): string {
  return result.content
    .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

/**
 * Documents a tool attached for the model to SEE — carried in the MCP
 * result's `_meta.renkeiDocuments`. Sent with the turn they arrive in;
 * not persisted (their extracted text rode the tool result), so a
 * conversation rebuilt after a pause reads the text alone.
 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ATTACHMENT_MAX_BLOCKS = 3;
const ATTACHMENT_MAX_BASE64_CHARS = 14_000_000;

type AttachmentBlock = Extract<LlmContentBlock, { type: 'document' | 'image' }>;

function attachmentBlocksOfMeta(meta: Record<string, unknown>): AttachmentBlock[] {
  const raw = meta.renkeiDocuments;
  if (!Array.isArray(raw)) return [];
  const blocks: AttachmentBlock[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { mediaType, dataBase64, title } = entry;
    if (typeof mediaType !== 'string' || typeof dataBase64 !== 'string' || !dataBase64) continue;
    if (mediaType === 'application/pdf') {
      blocks.push({
        type: 'document',
        mediaType,
        dataBase64,
        ...(typeof title === 'string' && title ? { title } : {}),
      });
    } else if (IMAGE_MEDIA_TYPES.has(mediaType)) {
      blocks.push({ type: 'image', mediaType, dataBase64 });
    }
  }
  return blocks;
}

/**
 * Set to `true` to log the VERBATIM provider request body on a model error
 * (encrypted at rest through secure()). Off, the line carries only the
 * content-free summary — field names, sizes, roles, the URL.
 */
const WIRE_DEBUG_ENV = 'AGENT_LLM_DEBUG_WIRE';

function wireDebugOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WIRE_DEBUG_ENV]?.trim().toLowerCase() === 'true';
}

/** The request fields for a model-error log line (see WIRE_DEBUG_ENV). */
export function requestLogFieldOf(
  cause: unknown,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const parsed = wireRequestCauseOf(cause);
  if (!parsed) return {};
  return {
    url: parsed.url,
    requestSummary: parsed.summary,
    ...(wireDebugOn(env)
      ? {
          headers: maskCredentialHeaders(parsed.headers, secure),
          request: secure(JSON.stringify(parsed.request)),
        }
      : {}),
  };
}

/** The owner's name for a log line — total: a run never fails over a display name. */
async function describeActor(
  db: Kysely<DB>,
  subject: string | null | undefined
): Promise<{ subject: string; displayName: string }> {
  try {
    return await describeActorRaw(db, subject);
  } catch {
    return { subject: subject ?? '(none)', displayName: subject ?? '(none)' };
  }
}

function resolveTimeArgsOf(input: unknown): ResolveTimeRequest {
  const args = argsOf(input);
  const snap = (value: unknown): 'hour' | 'day' | 'week' | 'month' | undefined =>
    value === 'hour' || value === 'day' || value === 'week' || value === 'month'
      ? value
      : undefined;
  const unit: TimeUnit | undefined = TIME_UNITS.find((known) => known === args.unit);
  const startOf = snap(args.startOf);
  const endOf = snap(args.endOf);
  return {
    timezone: typeof args.timezone === 'string' ? args.timezone : '',
    ...(typeof args.anchor === 'string' ? { anchor: args.anchor } : {}),
    ...(typeof args.amount === 'number' ? { amount: args.amount } : {}),
    ...(unit ? { unit } : {}),
    ...(typeof args.atTime === 'string' ? { atTime: args.atTime } : {}),
    ...(startOf ? { startOf } : {}),
    ...(endOf ? { endOf } : {}),
  };
}

/**
 * Trailing tool-call markup a model sometimes leaves inside a string
 * argument (`</result>\n</invoke>`). Only closing tags at the very end
 * are stripped — markup mid-text is untouched.
 */
const TOOL_RESIDUE = /(?:\s*<\/[a-z_][\w:-]*>)+\s*$/i;

function stripToolResidue(text: string): string {
  return text.replace(TOOL_RESIDUE, '').trim();
}

function finishArgsOf(input: unknown): {
  outcome: 'done' | 'nothing_to_do' | 'failed';
  summary: string;
  result: string | null;
  quiet: boolean;
} | null {
  const args = argsOf(input);
  const outcome = args.outcome;
  if (outcome !== 'done' && outcome !== 'nothing_to_do' && outcome !== 'failed') return null;
  const summary = typeof args.summary === 'string' ? stripToolResidue(args.summary) : '';
  if (!summary) return null;
  return {
    outcome,
    summary,
    result:
      typeof args.result === 'string' && args.result.trim()
        ? clip(stripToolResidue(args.result), RUN_RESULT_CHARS)
        : null,
    quiet: outcome === 'nothing_to_do' && args.quiet === true,
  };
}

/**
 * ask_person's arguments. Only `message` is required — a malformed `form`
 * degrades to a message-only question rather than refusing the call.
 */
function rememberArgsOf(input: unknown): { note: string } | null {
  const args = argsOf(input);
  const note = typeof args.note === 'string' ? stripToolResidue(args.note).trim() : '';
  return note ? { note } : null;
}

/** A card's `result.answers` — the form reply keyed by field name. */
function answersOf(result: unknown): Record<string, unknown> {
  const answers = isRecord(result) ? result.answers : undefined;
  return isRecord(answers) ? answers : {};
}

function commentOf(result: unknown): string | null {
  const comment = isRecord(result) ? result.comment : undefined;
  return typeof comment === 'string' && comment.trim() ? comment.trim() : null;
}

/** A stored detail → the turn's shape (fields that do not read are dropped). */
function turnDetailOf(value: unknown): TurnDetail {
  if (!isRecord(value)) return {};
  // The detail is the engine's own write, read back; the guards below are
  // for the fields whose shape later code branches on.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- engine-written JSON
  const detail = value as TurnDetail;
  return {
    ...detail,
    assistant: Array.isArray(detail.assistant) ? detail.assistant : undefined,
    results: Array.isArray(detail.results) ? detail.results : undefined,
    toolCalls: Array.isArray(detail.toolCalls) ? detail.toolCalls : undefined,
    modelCalls: Array.isArray(detail.modelCalls) ? detail.modelCalls : undefined,
    compaction:
      isRecord(detail.compaction) &&
      typeof detail.compaction.summary === 'string' &&
      typeof detail.compaction.through === 'number'
        ? { summary: detail.compaction.summary, through: detail.compaction.through }
        : undefined,
  };
}

/** The latest fold any turn made, or null when the run was never compacted. */
function latestCompaction(turns: readonly TurnRow[]): { summary: string; through: number } | null {
  let latest: { summary: string; through: number } | null = null;
  for (const turn of turns) {
    const fold = turn.detail.compaction;
    if (fold && (!latest || fold.through > latest.through)) latest = fold;
  }
  return latest;
}

/** A "your request is longer than the model takes" refusal, in any provider's words. */
function isContextOverflow(message: string | undefined): boolean {
  return /prompt is too long|too many tokens|context length|context window|maximum context|input is too long|exceeds the (maximum|context)|token limit/i.test(
    message ?? ''
  );
}

function toolUsesOf(blocks: LlmContentBlock[] | undefined): ToolUseBlock[] {
  return (blocks ?? []).filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

export function createAgentRunHandler(deps: EngineDeps) {
  const db = deps.db;
  const createClient =
    deps.createMcpClient ??
    ((token: string, base: string, runId?: string) =>
      new AgentMcpClient(`${base.replace(/\/+$/, '')}/api/mcp/mcp`, token, {
        ...(runId ? { runId } : {}),
      }));
  const mint = deps.mintToken ?? mintRunToken;
  const revoke = deps.revokeToken ?? revokeRunToken;
  const resolveLlm = deps.resolveLlm ?? resolveAgentLlm;
  const now = deps.now ?? (() => Date.now());

  async function handleRun(message: { payload: Json }): Promise<void> {
    const payload = isRecord(message.payload) ? message.payload : {};
    if (typeof payload.runId !== 'string') {
      // A malformed pointer can never become valid; log and complete.
      logger.error('agent job without runId; dropping', { component: 'worker-agents/engine' });
      return;
    }
    const runId = payload.runId;

    const run = await db
      .selectFrom('agent_runs')
      .select([
        'id',
        'agent_id',
        'owner_subject',
        'definition_snapshot',
        'llm_model_id',
        'initial_state',
        'status',
        'started_at',
        'waiting_until',
        'cancel_requested_at',
        'resumed_at',
        'resume_guidance',
        'resume_failure',
        'error_kind',
        'trigger_kind',
        'parent_run_id',
        'active_ms',
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
    if (['succeeded', 'failed', 'canceled', 'stopped'].includes(run.status)) return;

    try {
      await executeRun(run);
    } catch (error) {
      if (error instanceof TransientFailure) throw error; // → queue backoff
      if (error instanceof ExecutorStopping) {
        logger.info('run {runId} handed back: this executor is stopping', {
          component: 'worker-agents/engine',
          runId,
        });
        throw new MessageReleased('the agents worker is stopping');
      }
      throw error;
    }
  }

  async function executeRun(run: RunRow): Promise<void> {
    const runId = run.id;

    const settingsResult = await getOrgSettings();
    if (!settingsResult.ok) throw new TransientFailure('org settings unavailable');
    const settings = settingsResult.val;

    const definition = parseAgentDefinition(run.definition_snapshot);
    if (!definition) {
      await finalizeRun(run, 'failed', 'config', 'The saved instructions could not be read.', {});
      return;
    }

    // Guardrails and the question/auto-accept switches are LIVE-READ: a
    // rule tightened mid-flight bites this run's next model call.
    const agentRow = await db
      .selectFrom('agents')
      .select(['enabled', 'name', 'guardrails', 'can_ask_questions', 'auto_accept_actions'])
      .where('id', '=', run.agent_id)
      .executeTakeFirst();
    if (!agentRow) {
      await finalizeRun(run, 'failed', 'config', 'The agent no longer exists.', {});
      return;
    }

    // The owner's key must be delegated for anything of theirs to open
    // (docs/delegate-key-design.md). Without it the run is PARKED —
    // 'waiting', error_kind 'needs-sign-in' — and the owner's next sign-in
    // re-queues it.
    const owner = await delegateClient().forRun(runId).keyStatus(run.owner_subject);
    if (!owner.ok) throw new TransientFailure('key service unavailable');
    const delegated =
      owner.val.enrolled &&
      (owner.val.automationInstances.length > 0 || owner.val.sessionInstances.length > 0);
    if (!delegated && !run.cancel_requested_at) {
      await db
        .updateTable('agent_runs')
        .set({
          status: 'waiting',
          waiting_until: null,
          error_kind: 'needs-sign-in',
          error: owner.val.enrolled
            ? 'Paused: your encryption key is not available to your agents. Sign in to resume.'
            : 'Paused: finish setting up your encryption key by signing in, then this run resumes.',
          updated_at: sql`NOW()`,
        })
        .where('id', '=', runId)
        .execute();
      logger.info('run {runId} parked: owner key not delegated', {
        component: 'worker-agents/engine',
        runId,
      });
      return;
    }

    // A cancel request — or a disabled agent — wins over resuming.
    // Run-status transitions belong to the ENGINE alone: the route that
    // took the cancel click only set the flag and woke us.
    const cancelReason = run.cancel_requested_at
      ? 'canceled-by-owner'
      : !agentRow.enabled
        ? 'agent-disabled'
        : null;
    if (cancelReason && (run.status === 'queued' || run.status === 'waiting')) {
      await cancelWaiting(run, cancelReason);
      return;
    }

    const llmResult = await resolveLlm(db, run.llm_model_id);
    if (!llmResult.ok) {
      if (llmResult.err.type === 'DB_ERROR') throw new TransientFailure('model config unavailable');
      await finalizeRun(
        run,
        'failed',
        'config',
        llmResult.err.message ?? 'No model is configured for this organization.',
        {}
      );
      return;
    }
    const llm = llmResult.val;

    const phiRefusal = phiCoveredModelRefusal(
      settings.phiConnectorsRequireCoveredModel,
      definition.tools,
      llm
    );
    if (phiRefusal) {
      await finalizeRun(run, 'failed', 'config', phiRefusal, {});
      return;
    }

    const limits: RunLimits = {
      minutes: settings.agentRunTimeoutMinutes,
      toolCalls: Math.max(1, settings.agentRunToolCallBudget),
    };
    const tokenTtl = settings.agentRunTimeoutMinutes * 60 + TOKEN_SLACK_SECONDS;

    // The PROBE token names every tool the agent selected (plus the
    // notifier's own): it is how the engine learns which of them read and
    // which act, and it carries the notifier's mail/WebEx calls. The model
    // never reaches it.
    const probeToken = await mint(db, {
      subject: run.owner_subject,
      agentId: run.agent_id,
      ttlSeconds: tokenTtl,
      tools: [...new Set([...definition.tools, ...NOTIFIER_TOOLS])],
    });
    const minted = [probeToken];
    try {
      const probe = createClient(probeToken, deps.webBaseUrl, run.id);
      await probe.initialize();
      const listed = await probe.listTools();
      const toolsByName = new Map(listed.map((tool) => [tool.name, tool]));
      const selected = definition.tools.flatMap((name) => {
        const info = toolsByName.get(name);
        return info ? [info] : [];
      });
      const readTools = selected.filter((tool) => tool.kind === 'read');
      // Unknown reads as act — the capability gate's own conservative call.
      const actTools = selected.filter((tool) => tool.kind !== 'read');
      const missing = definition.tools.filter((name) => !toolsByName.has(name));

      const context = await loadRunContext(run.agent_id);
      // The MODEL's token: read tools only. However the conversation goes,
      // nothing the agent calls can change a system — the gateway does not
      // register an act tool for this token at all.
      const agentToken = await mint(db, {
        subject: run.owner_subject,
        agentId: run.agent_id,
        ttlSeconds: tokenTtl,
        tools: [
          ...readTools.map((tool) => tool.name),
          ...(context.knowledgeText ? [KNOWLEDGE_TOOL] : []),
        ],
      });
      minted.push(agentToken);
      const mcp = createClient(agentToken, deps.webBaseUrl, run.id);
      await mcp.initialize();
      const agentTools = await mcp.listTools();
      const callable = new Map(
        agentTools.filter((tool) => tool.kind === 'read').map((tool) => [tool.name, tool])
      );

      const vars = await baseVariables(run);
      const notifier = await notifierFor(db, {
        subject: run.owner_subject,
        agentId: run.agent_id,
        agentName: agentRow.name,
        runId: run.id,
        mcp: probe,
        toolsByName,
        ownerEmail: vars['user.email'],
      });

      // Becoming 'running': a fresh run, a wake from a pause, a resume.
      const firstStart = run.status === 'queued' && run.started_at === null;
      if (run.status === 'queued' || run.status === 'waiting') {
        await db
          .updateTable('agent_runs')
          .set({
            status: 'running',
            started_at: run.started_at ?? new Date(now()),
            // waiting_until stays: a pause that is still pending re-parks
            // with the deadline it already had.
            llm_model_id: llm.modelConfigId,
            ...(run.error_kind === 'needs-sign-in' ? { error_kind: null, error: null } : {}),
            updated_at: sql`NOW()`,
          })
          .where('id', '=', runId)
          .execute();
      }
      if (firstStart && run.resumed_at === null) void notifier.runStarted();

      const canAsk = agentRow.can_ask_questions === true;
      const offered: LlmToolDef[] = [
        FINISH_RUN_DEF,
        ...(actTools.length > 0
          ? [
              buildStageActionsDef(
                actTools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                }))
              ),
            ]
          : []),
        REMEMBER_DEF,
        RESOLVE_TIME_DEF,
        ...(canAsk ? [ASK_PERSON_DEF] : []),
        // Only worth offering when there is something to read.
        ...(callable.size > 0 ? [SPAWN_AGENT_DEF] : []),
        ...[...callable.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ];
      const stageable = new Set(actTools.map((tool) => tool.name));

      const loop = new RunLoop({
        run,
        definition,
        agentName: agentRow.name,
        guardrails: agentRow.guardrails ?? '',
        canAsk,
        autoAccept: agentRow.auto_accept_actions === true,
        externallyTriggered: await runIsExternallyTriggered(run),
        actPolicy: settings.agentActStepsRequireApproval,
        approvalWaitCapHours: settings.agentApprovalMaxWaitDays * 24,
        limits,
        llm,
        mcp,
        probe,
        toolsByName,
        callable,
        stageable,
        offered,
        missing,
        context,
        notifier,
        vars,
      });
      await loop.execute();
    } finally {
      for (const token of minted) await revoke(db, token);
    }
  }

  interface LoopInput {
    run: RunRow;
    definition: AgentDefinition;
    agentName: string;
    guardrails: string;
    canAsk: boolean;
    autoAccept: boolean;
    externallyTriggered: boolean;
    actPolicy: 'externally_triggered' | 'all' | 'off';
    approvalWaitCapHours: number;
    limits: RunLimits;
    llm: ResolvedLlm;
    /** The model's client — read tools only. */
    mcp: McpClient;
    /** The probe/notifier client — never driven by the model. */
    probe: McpClient;
    toolsByName: Map<string, McpToolInfo>;
    callable: Map<string, McpToolInfo>;
    stageable: Set<string>;
    offered: LlmToolDef[];
    /** Selected tools the owner no longer has — told to the agent once. */
    missing: string[];
    context: { memoryText: string; knowledgeText: string };
    notifier: Notifier;
    vars: Record<string, string>;
  }

  /**
   * One execution of a run, from wherever it stands to the next point it
   * finishes, pauses, or is handed back. A class only so the turn helpers
   * share the run's state without a dozen parameters each.
   */
  class RunLoop {
    private readonly input: LoopInput;
    private readonly segmentStartedAt = now();
    /** Active time spent before this execution, in ms. */
    private readonly priorActiveMs: number;

    constructor(input: LoopInput) {
      this.input = input;
      this.priorActiveMs = Number(input.run.active_ms ?? 0);
    }

    private get runRow(): RunRow {
      return this.input.run;
    }

    private activeMs(): number {
      return this.priorActiveMs + (now() - this.segmentStartedAt);
    }

    private minutesLeft(): number {
      return (this.input.limits.minutes * 60_000 - this.activeMs()) / 60_000;
    }

    /** The checkpoints before anything that spends time or acts. */
    private async checkpoint(): Promise<void> {
      if (this.minutesLeft() <= 0) {
        throw new RunAbort(
          'timeout',
          `The run used its ${this.input.limits.minutes} minutes of active time.`
        );
      }
      if (await isCanceled(this.runRow.id)) throw new RunCanceled();
      if (deps.stopRequested?.()) throw new ExecutorStopping();
    }

    /** Persist the active-time clock — on every turn, and before control leaves. */
    private async saveClock(): Promise<void> {
      await db
        .updateTable('agent_runs')
        .set({ active_ms: Math.round(this.activeMs()), updated_at: sql`NOW()` })
        .where('id', '=', this.runRow.id)
        .execute();
    }

    async execute(): Promise<void> {
      try {
        await this.drive();
      } catch (error) {
        if (error instanceof RunAbort) {
          await this.saveClock();
          await this.closeOpenTurn('failed');
          await finalizeRun(this.runRow, 'failed', error.kind, error.message, {});
          return;
        }
        if (error instanceof RunCanceled) {
          await this.saveClock();
          await this.closeOpenTurn('canceled');
          await finalizeRun(this.runRow, 'canceled', null, null, {}, true);
          return;
        }
        if (error instanceof ExecutorStopping || error instanceof TransientFailure) {
          await this.saveClock();
        }
        throw error;
      }
    }

    private async closeOpenTurn(status: 'failed' | 'canceled'): Promise<void> {
      await db
        .updateTable('agent_run_steps')
        .set({ status, finished_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('run_id', '=', this.runRow.id)
        .where('status', 'in', ['running', 'waiting'])
        .execute();
    }

    private async drive(): Promise<void> {
      // Loaded once: this executor is the run's only writer (the unique
      // turn index is the tripwire), so the rows in hand stay the truth.
      const turns = await this.loadTurns();
      let idleTurns = 0;
      let turnsOverBudget = 0;
      for (;;) {
        const last = turns[turns.length - 1];

        // Where the conversation stands decides what happens next. A turn
        // from before an owner's resume is history: the run goes on past it.
        const resumedPast =
          last !== undefined &&
          this.runRow.resumed_at !== null &&
          new Date(this.runRow.resumed_at).getTime() > last.created_at.getTime();
        if (last && !resumedPast && last.status === 'succeeded' && last.detail.finish) {
          // Finished, but the run row did not say so (a crash between the
          // two writes): finalize from what the row recorded.
          await this.finalizeFrom(last.detail);
          return;
        }
        if (last && last.status === 'waiting') {
          if ((await this.resolvePause(last)) === 'waiting') return;
          continue; // the turn is running again — continue its tool calls
        }
        if (last && last.status === 'running' && last.detail.assistant) {
          const outcome = await this.continueTurn(last, turns);
          if (outcome === 'paused' || outcome === 'finished') return;
          continue;
        }

        await this.checkpoint();
        // Out of tool calls: one last model turn, forced to finish_run, so
        // the run ends with the agent's own account of where it got to.
        const exhausted = this.budgetLeft(turns).toolCalls <= 0;
        if (exhausted) {
          turnsOverBudget += 1;
          if (turnsOverBudget > 1) {
            throw new RunAbort(
              'budget',
              `The run used its ${this.input.limits.toolCalls} tool calls without finishing.`
            );
          }
        }

        // A model call: into the open row a crash left without one, or a new row.
        let row: TurnRow;
        if (last && last.status === 'running' && !last.detail.assistant) {
          row = last;
        } else {
          row = await this.openTurn(turns);
          turns.push(row);
        }
        const answered = await this.callModel(row, turns, exhausted);
        if (answered === 'idle') {
          idleTurns += 1;
          if (idleTurns >= MAX_IDLE_TURNS) {
            throw new RunAbort('llm_error', 'The model stopped calling tools without finishing.');
          }
        } else {
          idleTurns = 0;
        }
      }
    }

    /** Every turn row of this run, opened, oldest first. */
    private async loadTurns(): Promise<TurnRow[]> {
      const rows = await db
        .selectFrom('agent_run_steps')
        .select(['id', 'attempt', 'status', 'created_at', 'tool_call_count', 'detail'])
        .where('run_id', '=', this.runRow.id)
        .where('step_id', '=', TURN_STEP_ID)
        .orderBy('attempt')
        .execute();
      const opened = await openDetails(this.runRow, rows);
      return opened.map((row) => ({
        id: row.id,
        attempt: row.attempt,
        status: row.status,
        created_at: new Date(row.created_at),
        tool_call_count: row.tool_call_count,
        detail: turnDetailOf(row.detail),
      }));
    }

    /** Tool calls billed since the run started — or since its last resume. */
    private toolCallsSpent(turns: TurnRow[]): number {
      const since = this.runRow.resumed_at ? new Date(this.runRow.resumed_at).getTime() : 0;
      return turns
        .filter((turn) => turn.created_at.getTime() >= since)
        .reduce((sum, turn) => sum + turn.tool_call_count, 0);
    }

    private budgetLeft(turns: TurnRow[], pending = 0): { toolCalls: number; minutes: number } {
      return {
        toolCalls: this.input.limits.toolCalls - this.toolCallsSpent(turns) - pending,
        minutes: this.minutesLeft(),
      };
    }

    /**
     * A new turn row. The first carries the run's opening message; the
     * first after a resume carries the resume note.
     */
    private async openTurn(turns: TurnRow[]): Promise<TurnRow> {
      const attempt = (turns[turns.length - 1]?.attempt ?? 0) + 1;
      const resumedAt = this.runRow.resumed_at ? new Date(this.runRow.resumed_at).getTime() : null;
      const resumedSinceLastTurn =
        resumedAt !== null &&
        turns.length > 0 &&
        turns.every((turn) => turn.created_at.getTime() < resumedAt);
      const previous = turns[turns.length - 1];
      const detail: TurnDetail = {};
      if (turns.length === 0) {
        detail.opening = this.openingText();
      } else if (resumedSinceLastTurn) {
        detail.opening = resumeMessage({
          failure: this.runRow.resume_failure,
          guidance: this.runRow.resume_guidance,
        });
      } else if (previous?.detail.assistant && toolUsesOf(previous.detail.assistant).length === 0) {
        // The last reply called no tool: the conversation needs a user
        // turn, and the agent needs telling what moves it on.
        detail.opening = IDLE_NUDGE;
      }
      const id = randomUUID();
      try {
        await db
          .insertInto('agent_run_steps')
          .values({
            id,
            run_id: this.runRow.id,
            step_id: TURN_STEP_ID,
            step_index: attempt,
            attempt,
            iteration: 0,
            status: 'running',
            started_at: sql`NOW()`,
            detail: await sealedDetailJson(this.runRow, { ...detail }),
          })
          .execute();
      } catch (error) {
        // The unique (run, step, iteration, attempt) tripwire: another
        // executor holds this run. Back off; the queue redelivers.
        throw new TransientFailure(
          `turn ${attempt} already exists: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return {
        id,
        attempt,
        status: 'running',
        created_at: new Date(now()),
        tool_call_count: 0,
        detail,
      };
    }

    private openingText(): string {
      const { vars, missing } = this.input;
      const facts: Record<string, string> = {};
      for (const builtin of BUILTIN_VARIABLES) {
        if (vars[builtin.name]) facts[builtin.name] = vars[builtin.name];
      }
      facts.now = new Date(now()).toISOString();
      // Named outright: a model works the weekday out from a date wrongly
      // often enough to matter ("next Monday" is then off by a day).
      facts.weekday = `${weekdayOf(new Date(now()))} (UTC)`;
      const triggerValues = Object.fromEntries(
        Object.entries(vars).filter(([name]) => name.startsWith('trigger.'))
      );
      const opening = buildRunOpening({
        facts,
        triggerValues,
        startedBy: startedByText(this.runRow.trigger_kind),
      }).content[0].text;
      return missing.length > 0
        ? `${opening}\n\nNot available to you this run (the owner no longer has them): ${missing.join(', ')}.`
        : opening;
    }

    /** The conversation so far, as the model is sent it. */
    private messagesOf(turns: TurnRow[]): LlmMessage[] {
      const messages: LlmMessage[] = [];
      let pending: LlmContentBlock[] = [];
      // After a fold: the run's opening, the summary, then the turns after it.
      const fold = latestCompaction(turns);
      const opening = turns[0]?.detail.opening;
      const visible = fold ? turns.filter((turn) => turn.attempt > fold.through) : turns;
      if (fold) {
        if (opening) pending.push({ type: 'text', text: opening });
        pending.push({ type: 'text', text: summaryOpening(fold.summary, fold.through) });
      }
      visible.forEach((turn, index) => {
        const isLast = index === visible.length - 1;
        if (turn.detail.opening) pending.push({ type: 'text', text: turn.detail.opening });
        if (!turn.detail.assistant) return;
        if (pending.length > 0) messages.push({ role: 'user', content: pending });
        messages.push({ role: 'assistant', content: turn.detail.assistant });
        const results = [...(turn.detail.results ?? [])];
        // A turn that ended before answering every call (a timeout, a
        // failure the owner resumed) still owes each one a result.
        if (!isLast || turn.status !== 'running') {
          const answered = new Set(results.map((result) => result.toolUseId));
          for (const use of toolUsesOf(turn.detail.assistant)) {
            if (!answered.has(use.id)) {
              results.push({
                type: 'tool_result',
                toolUseId: use.id,
                content: 'Not run: the run stopped before this call.',
                isError: true,
              });
            }
          }
        }
        pending = results;
      });
      if (pending.length > 0) messages.push({ role: 'user', content: pending });
      return messages;
    }

    private systemPrompt(): string {
      return runSystemPrompt(
        this.input.limits,
        { canAsk: this.input.canAsk },
        {
          agentName: this.input.agentName,
          instructions: this.input.definition.instructions,
          guardrailsText: this.input.guardrails,
          knowledgeText: this.input.context.knowledgeText,
          memoryText: this.input.context.memoryText,
        }
      );
    }

    /** Characters of conversation one request may carry, from the model's window. */
    private transcriptBudget(): number {
      const { llm } = this.input;
      return transcriptBudgetChars({
        contextWindowTokens: contextWindowOfLlm(llm),
        maxOutputTokens: llm.maxOutputTokens,
        fixedChars: this.systemPrompt().length + JSON.stringify(this.input.offered).length,
      });
    }

    /**
     * Fold the turns before the recent few into a summary the run's own
     * model writes (run-compaction.ts), kept on `row`. Answers the fold's
     * token usage, or null when there was nothing old enough to fold or
     * the folding call failed — the request is then cut to fit instead,
     * which loses more but never stops the run.
     */
    private async compact(row: TurnRow, turns: TurnRow[]): Promise<UsageTotals | null> {
      const { llm } = this.input;
      const prior = latestCompaction(turns);
      const done = turns.filter(
        (turn) =>
          turn.id !== row.id && turn.detail.assistant && turn.attempt > (prior?.through ?? 0)
      );
      const foldable = done.slice(0, Math.max(0, done.length - RUN_KEEP_RECENT_TURNS));
      if (foldable.length === 0) return null;
      const usage = emptyUsage();
      const startedAt = now();
      let summary = prior?.summary ?? null;
      for (const batch of foldBatches(
        foldable.map((turn) => ({
          attempt: turn.attempt,
          ...(turn.detail.opening ? { opening: turn.detail.opening } : {}),
          ...(turn.detail.assistant ? { assistant: turn.detail.assistant } : {}),
          ...(turn.detail.results ? { results: turn.detail.results } : {}),
        }))
      )) {
        const folded = await llm.provider.complete({
          system: RUN_COMPACTION_SYSTEM,
          messages: [
            { role: 'user', content: [{ type: 'text', text: foldRequestText(summary, batch) }] },
          ],
          tools: [],
          maxTokens: Math.min(llm.maxOutputTokens, 8_000),
        });
        if (!folded.ok) {
          const kind = folded.err.type;
          if (kind === 'rate_limit' || kind === 'overloaded' || kind === 'network') {
            throw new TransientFailure(`compaction model ${kind}`);
          }
          logger.warn('run {runId}: compaction failed ({kind}); cutting to fit instead', {
            component: 'worker-agents/engine',
            runId: this.runRow.id,
            kind,
          });
          return null;
        }
        addUsage(usage, folded.val.usage);
        const text = folded.val.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim();
        if (text) summary = clip(text, RUN_SUMMARY_MAX_CHARS);
      }
      await recordUsage(this.runRow, usage, llm, now() - startedAt);
      if (!summary) return usage;
      const through = foldable[foldable.length - 1].attempt;
      row.detail.compaction = { summary, through };
      await this.writeTurn(row, 'running');
      logger.info('run {runId}: folded turns {from}–{through} into a summary', {
        component: 'worker-agents/engine',
        runId: this.runRow.id,
        from: foldable[0].attempt,
        through,
      });
      return usage;
    }

    /** One model call into `row`. 'idle' when the reply called no tool. */
    private async callModel(
      row: TurnRow,
      turns: TurnRow[],
      finishOnly: boolean
    ): Promise<'ok' | 'idle'> {
      const { llm } = this.input;
      const budget = this.transcriptBudget();
      let foldUsage: UsageTotals | null = null;
      let conversation = this.messagesOf(turns);
      if (messagesChars(conversation) > budget) {
        foldUsage = await this.compact(row, turns);
        if (foldUsage) conversation = this.messagesOf(turns);
      }
      // Whatever is left over budget — a single turn too big on its own —
      // is cut to fit (fitMessages); the stored turns keep everything.
      const messages = fitMessages(conversation, budget).messages;
      const tail = messages[messages.length - 1];
      if (this.pendingAttachments.length > 0 && tail?.role === 'user') {
        // Documents ride only on the turn they arrived in: this call sees
        // them, a conversation rebuilt later reads their text alone.
        messages[messages.length - 1] = {
          ...tail,
          content: [...tail.content, ...this.pendingAttachments],
        };
      }
      this.pendingAttachments = [];
      const startedAt = now();
      const request = (sent: LlmMessage[]) =>
        llm.provider.complete({
          system: this.systemPrompt(),
          messages: sent,
          // The tool list never changes within a run: it heads the cached
          // prefix. Exhaustion is expressed through tool_choice alone.
          tools: this.input.offered,
          toolChoice: finishOnly ? { name: FINISH_RUN_TOOL } : 'any',
          promptCache: true,
          maxTokens: llm.maxOutputTokens,
          ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
        });
      let completion = await request(messages);
      if (
        !completion.ok &&
        completion.err.type === 'invalid_request' &&
        isContextOverflow(completion.err.message)
      ) {
        // The estimate was optimistic for this model: once more, at half.
        logger.warn('run {runId}: the model refused the request as too long; retrying smaller', {
          component: 'worker-agents/engine',
          runId: this.runRow.id,
        });
        completion = await request(fitMessages(messages, Math.floor(budget / 2)).messages);
      }
      if (!completion.ok) {
        const kind = completion.err.type;
        logger.error('model error in run {runId}: {kind} {message}', {
          component: 'worker-agents/engine',
          runId: this.runRow.id,
          kind,
          message: completion.err.message ?? '',
          ...requestLogFieldOf(completion.err.cause),
        });
        if (kind === 'auth') throw new RunAbort('llm_auth', 'The model rejected the API key.');
        if (kind === 'rate_limit' || kind === 'overloaded' || kind === 'network') {
          // The row stays open without a reply; the redelivery calls again.
          throw new TransientFailure(`model ${kind}`);
        }
        throw new RunAbort('llm_error', completion.err.message ?? `The model failed (${kind}).`);
      }
      const usage = emptyUsage();
      addUsage(usage, completion.val.usage);
      // The fold's own calls were recorded as they happened; the turn's
      // totals include them.
      if (foldUsage) addUsage(usage, foldUsage);
      const modelCall: ModelCallRecord = {
        durationMs: now() - startedAt,
        stopReason: completion.val.stopReason,
        inputTokens: completion.val.usage.inputTokens,
        outputTokens: completion.val.usage.outputTokens,
      };
      const content = completion.val.content;
      const text = content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      const idle = toolUsesOf(content).length === 0;
      row.detail = {
        ...row.detail,
        // An empty reply still has to be a message the provider accepts back.
        assistant: content.length > 0 ? content : [{ type: 'text', text: '(no reply)' }],
        ...(text ? { llmSummary: clip(text, PREVIEW_CHARS) } : {}),
        modelCalls: [modelCall],
        usage,
        toolCalls: [],
        results: [],
      };
      await recordUsage(this.runRow, usage, llm, modelCall.durationMs);
      await this.writeTurn(row, idle ? 'succeeded' : 'running');
      await this.saveClock();
      return idle ? 'idle' : 'ok';
    }

    /**
     * Work through the turn's tool calls in order, skipping those already
     * answered. Each real call is recorded before it is made (inFlight) and
     * its result written as soon as it lands, so a crash re-enters with no
     * call made twice.
     */
    private async continueTurn(
      row: TurnRow,
      turns: TurnRow[]
    ): Promise<'next' | 'paused' | 'finished'> {
      const uses = toolUsesOf(row.detail.assistant);
      const results = row.detail.results ?? [];
      const toolCalls = row.detail.toolCalls ?? [];
      const answered = new Set(results.map((result) => result.toolUseId));
      const attachments: AttachmentBlock[] = [];
      let finishing: ReturnType<typeof finishArgsOf> = null;
      const spawns: ToolUseBlock[] = [];

      // A call that was in flight when the last executor died: its outcome
      // is unknown, and making it again might act twice.
      if (row.detail.inFlight && !answered.has(row.detail.inFlight)) {
        results.push({
          type: 'tool_result',
          toolUseId: row.detail.inFlight,
          content:
            'This call was interrupted and its outcome is unknown. Check whether it took effect before repeating it.',
          isError: true,
        });
        answered.add(row.detail.inFlight);
        row.detail.inFlight = undefined;
      }

      const reply = async (result: ToolResultBlock, record?: ToolCallRecord) => {
        results.push(result);
        answered.add(result.toolUseId);
        if (record) toolCalls.push({ ...record, toolUseId: result.toolUseId });
        row.detail.results = results;
        row.detail.toolCalls = toolCalls;
        row.detail.inFlight = undefined;
        await this.writeTurn(row, 'running');
      };

      for (const use of uses) {
        if (answered.has(use.id)) continue;

        if (use.name === FINISH_RUN_TOOL) {
          const finish = finishArgsOf(use.input);
          if (!finish) {
            await reply({
              type: 'tool_result',
              toolUseId: use.id,
              content: 'finish_run needs {outcome: "done" | "nothing_to_do" | "failed", summary}.',
              isError: true,
            });
            continue;
          }
          // Answered last: any other calls in the same reply still run.
          finishing = finish;
          continue;
        }

        if (use.name === RESOLVE_TIME_TOOL) {
          const resolved = resolveTime(resolveTimeArgsOf(use.input));
          await reply(
            {
              type: 'tool_result',
              toolUseId: use.id,
              content: resolved.ok
                ? JSON.stringify(resolved.value)
                : `${resolved.error} Call ${RESOLVE_TIME_TOOL} again with that corrected — it is free.`,
              isError: !resolved.ok,
            },
            {
              free: true,
              tool: RESOLVE_TIME_TOOL,
              argsPreview: clip(JSON.stringify(use.input ?? {}), PREVIEW_CHARS),
              resultPreview: clip(
                resolved.ok ? `${resolved.value.iso} (${resolved.value.local})` : resolved.error,
                PREVIEW_CHARS
              ),
              isError: !resolved.ok,
              durationMs: 0,
            }
          );
          continue;
        }

        if (use.name === REMEMBER_TOOL) {
          const resultText = await this.remember(use.input);
          await reply(
            {
              type: 'tool_result',
              toolUseId: use.id,
              content: resultText.text,
              isError: resultText.isError,
            },
            {
              free: true,
              tool: REMEMBER_TOOL,
              argsPreview: clip(JSON.stringify(use.input ?? {}), PREVIEW_CHARS),
              resultPreview: clip(resultText.text, PREVIEW_CHARS),
              isError: resultText.isError,
              durationMs: 0,
            }
          );
          continue;
        }

        if (use.name === ASK_PERSON_TOOL && this.input.canAsk) {
          const asked = askedQuestionsOf(use.input);
          if (!asked.ok) {
            await reply({
              type: 'tool_result',
              toolUseId: use.id,
              content: asked.error,
              isError: true,
            });
            continue;
          }
          await this.pauseForQuestion(row, use.id, {
            message: asked.message,
            form: asked.form,
            ...(asked.timeoutHours !== undefined ? { timeoutHours: asked.timeoutHours } : {}),
          });
          return 'paused';
        }

        if (use.name === STAGE_ACTIONS_TOOL && this.input.stageable.size > 0) {
          const parsed = parseStagedActions(use.input, this.input.stageable);
          if ('error' in parsed) {
            await reply({
              type: 'tool_result',
              toolUseId: use.id,
              content: parsed.error,
              isError: true,
            });
            continue;
          }
          const left = this.budgetLeft(turns);
          if (parsed.actions.length > left.toolCalls) {
            await reply({
              type: 'tool_result',
              toolUseId: use.id,
              content: `This batch has ${parsed.actions.length} actions but only ${Math.max(0, left.toolCalls)} tool calls are left in your budget — stage only what matters most, or finish.`,
              isError: true,
            });
            continue;
          }
          await this.checkpoint();
          await this.stage(row, use, parsed.summary, parsed.actions);
          return 'paused';
        }

        if (use.name === SPAWN_AGENT_TOOL && this.input.callable.size > 0) {
          // Run together once the turn's other calls are answered.
          spawns.push(use);
          continue;
        }

        const info = this.input.callable.get(use.name);
        if (!info) {
          const content = this.input.stageable.has(use.name)
            ? `"${use.name}" changes something, so you cannot call it directly — propose it with ${STAGE_ACTIONS_TOOL}.`
            : `The tool "${use.name}" is not available to this agent.`;
          await reply({ type: 'tool_result', toolUseId: use.id, content, isError: true });
          continue;
        }

        if (this.budgetLeft(turns).toolCalls <= 0) {
          await reply({
            type: 'tool_result',
            toolUseId: use.id,
            content:
              'Tool budget spent — this call was not made. Call finish_run now with what you have.',
            isError: true,
          });
          continue;
        }

        await this.checkpoint();
        row.detail.inFlight = use.id;
        row.tool_call_count += 1;
        await this.writeTurn(row, 'running');
        const outcome = await this.callTool(use);
        for (const block of outcome.attachments) {
          if (attachments.length < ATTACHMENT_MAX_BLOCKS) attachments.push(block);
        }
        await reply(outcome.result, outcome.record);
      }

      if (spawns.length > 0) await this.runSpawns(row, turns, toolCalls, spawns, reply);

      if (finishing) {
        const finishUse = uses.find((use) => use.name === FINISH_RUN_TOOL && !answered.has(use.id));
        row.detail = {
          ...row.detail,
          finish: finishing.outcome,
          llmSummary: clip(finishing.summary, PREVIEW_CHARS),
          ...(finishing.result ? { result: finishing.result } : {}),
          quiet: finishing.quiet,
          results: [
            ...results,
            ...(finishUse
              ? [{ type: 'tool_result' as const, toolUseId: finishUse.id, content: 'Finished.' }]
              : []),
          ],
          toolCalls: [
            ...toolCalls,
            {
              free: true,
              tool: FINISH_RUN_TOOL,
              argsPreview: clip(JSON.stringify({ outcome: finishing.outcome }), PREVIEW_CHARS),
              resultPreview: '',
              isError: false,
              durationMs: 0,
            },
          ],
        };
        await this.writeTurn(row, 'succeeded');
        await this.saveClock();
        await this.finalizeFrom(row.detail);
        return 'finished';
      }

      // Every call answered: the budget line rides on the results, then
      // the turn closes and the next one is the model's.
      const withBudget = [...results];
      const lastResult = withBudget[withBudget.length - 1];
      if (lastResult) {
        withBudget[withBudget.length - 1] = {
          ...lastResult,
          content: `${lastResult.content}\n\n${budgetLine(this.budgetLeft(turns))}`,
        };
      }
      row.detail.results = withBudget;
      await this.writeTurn(row, 'succeeded');
      await this.saveClock();
      this.pendingAttachments = attachments;
      return 'next';
    }

    private pendingAttachments: AttachmentBlock[] = [];

    /** One real tool call through the agent's read-only client. */
    private async callTool(use: ToolUseBlock): Promise<{
      result: ToolResultBlock;
      record: ToolCallRecord;
      attachments: AttachmentBlock[];
    }> {
      const args = argsOf(use.input);
      const startedAt = now();
      let result: McpToolResult;
      try {
        result = await this.input.mcp.callTool(use.name, args);
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
      const durationMs = now() - startedAt;
      const resultText = textOf(result);
      const kind = toolKindOf(result.meta);
      if (result.isError) {
        logger.warn('agent "{agentName}": {toolLabel} failed — {error}', {
          component: 'worker-agents/engine',
          runId: this.runRow.id,
          agentId: this.runRow.agent_id,
          agentName: this.input.agentName,
          subject: this.runRow.owner_subject,
          toolLabel: friendlyToolName(use.name, null),
          tool: use.name,
          durationMs,
          error: clip(resultText, PREVIEW_CHARS),
        });
      }
      return {
        result: {
          type: 'tool_result',
          toolUseId: use.id,
          // Fenced as data (untrusted.ts): a result can carry a stranger's words.
          content: untrustedBlock(`tool:${use.name}`, clipForModel(resultText)),
          ...(result.isError ? { isError: true } : {}),
        },
        record: {
          tool: use.name,
          argsPreview: clip(JSON.stringify(args), PREVIEW_CHARS),
          resultPreview: clip(resultText, PREVIEW_CHARS),
          resultChars: resultText.length,
          isError: result.isError,
          durationMs,
          ...(kind ? { kind } : {}),
        },
        attachments: attachmentBlocksOfMeta(result.meta).filter(
          (block) => block.dataBase64.length <= ATTACHMENT_MAX_BASE64_CHARS
        ),
      };
    }

    /**
     * Run a turn's spawn_agent calls, at most MAX_CONCURRENT_SUB_AGENTS at
     * once and MAX_SUB_AGENTS_PER_RUN over the run (counted like the tool
     * budget: since the last resume). A spawn is not a tool call; the reads
     * inside it are, deducted from the parent's budget as each is made —
     * nothing is reserved, so a sub-agent that finishes early leaves the
     * rest for the parent or the next sub-agent.
     */
    private async runSpawns(
      row: TurnRow,
      turns: TurnRow[],
      toolCalls: ToolCallRecord[],
      spawns: ToolUseBlock[],
      reply: (result: ToolResultBlock, record?: ToolCallRecord) => Promise<void>
    ): Promise<void> {
      const refuse = (use: ToolUseBlock, content: string) =>
        reply({ type: 'tool_result', toolUseId: use.id, content, isError: true });
      const since = this.runRow.resumed_at ? new Date(this.runRow.resumed_at).getTime() : 0;
      const recorded = () =>
        turns
          .filter((turn) => turn.created_at.getTime() >= since)
          .reduce(
            (sum, turn) =>
              sum + (turn.detail.toolCalls ?? []).filter((c) => c.tool === SPAWN_AGENT_TOOL).length,
            0
          );
      let started = 0;
      const queue = [...spawns];
      const worker = async (): Promise<void> => {
        for (let use = queue.shift(); use; use = queue.shift()) {
          const spawn = spawnArgsOf(use.input);
          if (!spawn) {
            await refuse(use, 'spawn_agent needs {task}, a non-empty description of the job.');
            continue;
          }
          if (recorded() + started >= MAX_SUB_AGENTS_PER_RUN) {
            await refuse(
              use,
              `At most ${MAX_SUB_AGENTS_PER_RUN} sub-agents per run, and they are used up — do the rest yourself or finish.`
            );
            continue;
          }
          if (this.budgetLeft(turns).toolCalls <= 0) {
            await refuse(
              use,
              'Tool budget spent — the sub-agent was not started. Work from the reports you have, or finish.'
            );
            continue;
          }
          started += 1;
          let sub: Awaited<ReturnType<typeof this.runSubAgent>>;
          try {
            await this.checkpoint();
            sub = await this.runSubAgent(row, turns, toolCalls, spawn);
          } finally {
            started -= 1;
          }
          await reply(
            {
              type: 'tool_result',
              toolUseId: use.id,
              content: untrustedBlock('sub-agent', sub.report),
              ...(sub.isError ? { isError: true } : {}),
            },
            {
              tool: SPAWN_AGENT_TOOL,
              argsPreview: clip(JSON.stringify({ task: clip(spawn.task, 300) }), PREVIEW_CHARS),
              resultPreview: clip(sub.report, PREVIEW_CHARS),
              resultChars: sub.report.length,
              isError: sub.isError,
              durationMs: sub.durationMs,
              kind: 'read',
              free: true,
            }
          );
        }
      };
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(MAX_CONCURRENT_SUB_AGENTS, spawns.length) }, worker)
      );
      const failed = settled.find((outcome) => outcome.status === 'rejected');
      if (failed && failed.status === 'rejected') throw failed.reason;
    }

    /** The facts a sub-agent is told, the same the parent's opening states. */
    private subAgentFacts(): Record<string, string> {
      const facts: Record<string, string> = {};
      for (const builtin of BUILTIN_VARIABLES) {
        if (this.input.vars[builtin.name]) facts[builtin.name] = this.input.vars[builtin.name];
      }
      facts.now = new Date(now()).toISOString();
      facts.weekday = `${weekdayOf(new Date(now()))} (UTC)`;
      return facts;
    }

    /**
     * A read-only sub-agent: its own short conversation over some of the
     * parent's read tools (plus the free resolve_time), ending in one
     * written report. Each read is billed to the parent's turn row as it is
     * made, so the budget counts it, and logged on it; its model calls
     * ride the parent's usage. It has no stage, ask or spawn tools, so it
     * cannot change anything or recurse. When its own cap or the parent's
     * budget runs out mid-way it is told to stop and report.
     */
    private async runSubAgent(
      row: TurnRow,
      turns: TurnRow[],
      toolCalls: ToolCallRecord[],
      spawn: NonNullable<ReturnType<typeof spawnArgsOf>>
    ): Promise<{ report: string; isError: boolean; durationMs: number }> {
      const { callable, llm } = this.input;
      const startedAt = now();
      const requested = spawn.tools ?? [...callable.keys()];
      const names = requested.filter((name) => callable.has(name));
      const unknown = requested.filter((name) => !callable.has(name) && name !== RESOLVE_TIME_TOOL);
      const notes =
        unknown.length > 0 ? [`Not read tools of yours, left out: ${unknown.join(', ')}.`] : [];
      if (names.length === 0) {
        return {
          report: `No usable tools: name some of your read tools. ${notes.join(' ')}`.trim(),
          isError: true,
          durationMs: now() - startedAt,
        };
      }
      const cap = Math.max(
        1,
        Math.min(MAX_SUB_AGENT_TOOL_CALLS, spawn.maxToolCalls ?? MAX_SUB_AGENT_TOOL_CALLS)
      );
      const defs: LlmToolDef[] = [
        RESOLVE_TIME_DEF,
        ...names.map((name) => {
          const tool = callable.get(name)!;
          return { name, description: tool.description, inputSchema: tool.inputSchema };
        }),
      ];
      const allowed = new Set(names);
      const system = subAgentSystemPrompt({ toolCalls: cap, facts: this.subAgentFacts() });
      const messages: LlmMessage[] = [
        { role: 'user', content: [{ type: 'text', text: spawn.task }] },
      ];
      let calls = 0;
      let report = '';
      let isError = false;
      let wrapUp = false;

      for (let turn = 1; turn <= MAX_SUB_AGENT_TURNS; turn += 1) {
        await this.checkpoint();
        const turnStartedAt = now();
        const completion = await llm.provider.complete({
          system,
          messages: fitMessages(
            messages,
            transcriptBudgetChars({
              contextWindowTokens: contextWindowOfLlm(llm),
              maxOutputTokens: llm.maxOutputTokens,
              fixedChars: SUB_AGENT_FIXED_CHARS,
            })
          ).messages,
          // Once told to wrap up, it can only answer.
          tools: wrapUp ? [] : defs,
          ...(wrapUp ? {} : { toolChoice: 'auto' as const }),
          promptCache: true,
          maxTokens: llm.maxOutputTokens,
          ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
        });
        if (!completion.ok) {
          const kind = completion.err.type;
          // The same moment-bound failures that hand the parent's run back
          // to the queue do so here: the turn re-enters and only the spawns
          // still unanswered run again.
          if (kind === 'rate_limit' || kind === 'overloaded' || kind === 'network') {
            throw new TransientFailure(`sub-agent model ${kind}`);
          }
          report = `The sub-agent's model call failed (${kind}${completion.err.message ? `: ${clip(completion.err.message, 200)}` : ''}).`;
          isError = true;
          break;
        }
        const usage = emptyUsage();
        addUsage(usage, completion.val.usage);
        addUsage((row.detail.usage ??= emptyUsage()), completion.val.usage);
        await recordUsage(this.runRow, usage, llm, now() - turnStartedAt);

        const content = completion.val.content;
        const text = content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim();
        const uses = toolUsesOf(content);
        if (uses.length === 0 || wrapUp) {
          report = text;
          break;
        }
        messages.push({ role: 'assistant', content });
        const results: ToolResultBlock[] = [];
        let stopReason: string | null = null;
        for (const use of uses) {
          if (use.name === RESOLVE_TIME_TOOL) {
            const resolved = resolveTime(resolveTimeArgsOf(use.input));
            results.push({
              type: 'tool_result',
              toolUseId: use.id,
              content: resolved.ok ? JSON.stringify(resolved.value) : resolved.error,
              isError: !resolved.ok,
            });
            continue;
          }
          if (!allowed.has(use.name)) {
            results.push({
              type: 'tool_result',
              toolUseId: use.id,
              content: `The tool "${use.name}" is not available to you.`,
              isError: true,
            });
            continue;
          }
          // Deducted at use: the parent's budget as it stands now, shared
          // with the parent and any other sub-agent running beside this one.
          if (calls >= cap) stopReason = `your own cap of ${cap} tool calls`;
          else if (this.budgetLeft(turns).toolCalls <= 0) stopReason = "the run's tool budget";
          if (stopReason) {
            results.push({
              type: 'tool_result',
              toolUseId: use.id,
              content: `Not made: ${stopReason} is spent.`,
              isError: true,
            });
            continue;
          }
          calls += 1;
          row.tool_call_count += 1;
          const outcome = await this.callTool(use);
          toolCalls.push(outcome.record);
          results.push(outcome.result);
        }
        const blocks: LlmContentBlock[] = [...results];
        if (stopReason || turn === MAX_SUB_AGENT_TURNS - 1) {
          wrapUp = true;
          blocks.push({
            type: 'text',
            text: `Stop here: ${stopReason ? `${stopReason} is` : 'your turns are'} spent and no further tool call will be made. Reply now with your report, as plain text, from what you have — including what you did not get to.`,
          });
        }
        messages.push({ role: 'user', content: blocks });
      }

      if (!report) {
        report = 'The sub-agent ended without a report.';
        isError = true;
      }
      report = [
        ...notes,
        `(Sub-agent made ${calls} tool call${calls === 1 ? '' : 's'}, counted against your budget.)`,
        clipSubAgentReport(report),
      ].join('\n');
      return { report, isError, durationMs: now() - startedAt };
    }

    private async remember(input: unknown): Promise<{ text: string; isError: boolean }> {
      const remembered = rememberArgsOf(input);
      if (!remembered) return { text: 'remember needs {note}, a non-empty string.', isError: true };
      try {
        const { inserted } = await appendAgentMemory(db, {
          agentId: this.runRow.agent_id,
          content: remembered.note,
          runId: this.runRow.id,
        });
        if (!inserted) return { text: 'Already remembered — no change.', isError: false };
        this.input.context.memoryText = renderAgentMemory(
          await readAgentMemory(db, this.runRow.agent_id)
        );
        return { text: 'Remembered.', isError: false };
      } catch (error) {
        logger.warn('memory append failed for run {runId}: {error}', {
          component: 'worker-agents/engine',
          runId: this.runRow.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { text: 'Could not save that to memory.', isError: true };
      }
    }

    /** Writes of one row land in the order they were asked for, even when sub-agents finish together. */
    private writeChain: Promise<void> = Promise.resolve();

    private writeTurn(row: TurnRow, status: string): Promise<void> {
      const next = this.writeChain.then(() => this.writeTurnNow(row, status));
      this.writeChain = next.catch(() => undefined);
      return next;
    }

    /** Write the row: status, billed calls, the sealed detail. */
    private async writeTurnNow(row: TurnRow, status: string): Promise<void> {
      row.status = status;
      const usage = row.detail.usage ?? emptyUsage();
      await db
        .updateTable('agent_run_steps')
        .set({
          status,
          tool_call_count: row.tool_call_count,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens,
          cache_write_input_tokens: usage.cacheWriteInputTokens,
          outcome:
            status === 'succeeded' && row.detail.finish
              ? row.detail.finish
              : status === 'waiting'
                ? (row.detail.pause?.kind ?? null)
                : null,
          detail: await sealedDetailJson(this.runRow, { ...row.detail }),
          ...(status === 'running' || status === 'waiting' ? {} : { finished_at: sql`NOW()` }),
          updated_at: sql`NOW()`,
        })
        .where('id', '=', row.id)
        .execute();
    }

    /**
     * Stage a batch: the row, then — when a person must accept — the card,
     * or an auto-accept straight to the executor. Either way the run waits
     * and its clock stops.
     */
    private async stage(
      row: TurnRow,
      use: ToolUseBlock,
      summary: string,
      actions: StagedAction[]
    ): Promise<void> {
      const reason = actApprovalReason({
        tools: actions.map((action) => action.tool),
        autoAccept: this.input.autoAccept,
        policy: this.input.actPolicy,
        externallyTriggered: this.input.externallyTriggered,
      });
      const timeoutHours = argsOf(use.input).timeoutHours;
      const waitHours = Math.min(
        Math.max(
          1,
          typeof timeoutHours === 'number' ? timeoutHours : APPROVAL_DEFAULT_TIMEOUT_HOURS
        ),
        Math.max(1, this.input.approvalWaitCapHours)
      );
      const batchId = randomUUID();
      const waitingUntil = reason ? new Date(now() + waitHours * 3_600_000) : null;
      try {
        await db
          .insertInto('agent_action_batches')
          .values({
            id: batchId,
            run_id: this.runRow.id,
            agent_id: this.runRow.agent_id,
            owner_subject: this.runRow.owner_subject,
            turn: row.attempt,
            status: reason ? 'proposed' : 'accepted',
            summary,
            actions: JSON.stringify(actions),
            review_reason: reason,
            accepted_by: reason ? null : 'auto',
            decided_at: reason ? null : sql`NOW()`,
            waiting_until: waitingUntil,
          })
          .execute();
      } catch (error) {
        throw new TransientFailure(
          `batch for turn ${row.attempt} already exists: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      row.tool_call_count += actions.length;
      row.detail.pause = { kind: 'actions', toolUseId: use.id, batchId };
      row.detail.toolCalls = [
        ...(row.detail.toolCalls ?? []),
        {
          tool: STAGE_ACTIONS_TOOL,
          argsPreview: clip(JSON.stringify(use.input ?? {}), PREVIEW_CHARS),
          resultPreview: reason ? 'Waiting for acceptance.' : 'Accepted automatically.',
          isError: false,
          durationMs: 0,
          staged: actions.length,
        },
      ];
      await this.writeTurn(row, 'waiting');
      await this.saveClock();
      await db
        .updateTable('agent_runs')
        .set({ status: 'waiting', waiting_until: waitingUntil, updated_at: sql`NOW()` })
        .where('id', '=', this.runRow.id)
        .execute();
      if (reason) {
        await this.raiseBatchCard(row.attempt, batchId, summary, actions);
      } else {
        await enqueueBatch(this.runRow, batchId);
      }
      logger.info('run {runId} staged {count} action(s) ({how})', {
        component: 'worker-agents/engine',
        runId: this.runRow.id,
        count: actions.length,
        how: reason ? `waiting: ${reason}` : 'auto-accepted',
      });
    }

    private async raiseBatchCard(
      turn: number,
      batchId: string,
      summary: string,
      actions: StagedAction[]
    ): Promise<void> {
      const path = runPagePath(this.runRow);
      const link = approvalLink(path);
      const { agentName } = this.input;
      try {
        await db
          .insertInto('actionable_items')
          .values({
            id: randomUUID(),
            source: 'agents',
            status: 'suggested',
            kind: 'approval',
            title: `${agentName} — ${actions.length === 1 ? 'wants to make a change' : `wants to make ${actions.length} changes`}`,
            summary: clip(summary, PREVIEW_CHARS),
            evidence: JSON.stringify([]),
            // A snapshot: what a person is looking at keeps showing what it
            // showed. The executor reads the BATCH row, never this.
            suggested_action: JSON.stringify({ batchId, summary, actions }),
            owner_subject: this.runRow.owner_subject,
            created_by: this.runRow.owner_subject,
            created_by_agent_id: this.runRow.agent_id,
            run_id: this.runRow.id,
            step_id: TURN_STEP_ID,
            iteration: 0,
            attempt: turn,
          })
          .execute();
      } catch (error) {
        if (error instanceof Error && error.message.includes('idx_actionable_items_run_step')) {
          return; // a racing executor raised it already
        }
        throw error;
      }
      const heading = `Agent “${agentName}” wants your go-ahead`;
      await writeNotificationRow(
        db,
        {
          subject: this.runRow.owner_subject,
          agentId: this.runRow.agent_id,
          agentName,
          runId: this.runRow.id,
        },
        { kind: 'approval', headline: heading, stepId: null, refUrl: path }
      );
      const prefs = await getNotificationPrefs(this.runRow.owner_subject);
      const { deliverOwnerNotifications } = notificationDeliverer(
        this.input.probe,
        this.input.toolsByName
      );
      await deliverOwnerNotifications({
        email: prefs.approvalNeeded.email,
        webex: prefs.approvalNeeded.webex,
        heading,
        body: [
          summary,
          actions
            .map(
              (action, index) =>
                `${index + 1}. ${friendlyToolName(action.tool, null)} — ${action.reason}`
            )
            .join('\n'),
          ...(link ? [`Respond here: ${link}`] : []),
        ].join('\n\n'),
        ownerEmail: this.input.vars['user.email'],
      });
    }

    private async pauseForQuestion(
      row: TurnRow,
      toolUseId: string,
      asked: { message: string; form: FormNode[]; timeoutHours?: number }
    ): Promise<void> {
      const waitHours = Math.min(
        Math.max(1, asked.timeoutHours ?? APPROVAL_DEFAULT_TIMEOUT_HOURS),
        Math.max(1, this.input.approvalWaitCapHours)
      );
      const waitingUntil = new Date(now() + waitHours * 3_600_000);
      row.detail.pause = { kind: 'question', toolUseId, ...asked };
      row.detail.toolCalls = [
        ...(row.detail.toolCalls ?? []),
        {
          free: true,
          tool: ASK_PERSON_TOOL,
          argsPreview: clip(asked.message, PREVIEW_CHARS),
          resultPreview: 'Waiting for an answer.',
          isError: false,
          durationMs: 0,
        },
      ];
      await this.writeTurn(row, 'waiting');
      await this.saveClock();
      await db
        .updateTable('agent_runs')
        .set({ status: 'waiting', waiting_until: waitingUntil, updated_at: sql`NOW()` })
        .where('id', '=', this.runRow.id)
        .execute();
      await this.raiseQuestionCard(row.attempt, asked.message, asked.form);
    }

    private async raiseQuestionCard(
      turn: number,
      message: string,
      form: FormNode[]
    ): Promise<void> {
      const path = runPagePath(this.runRow);
      const link = approvalLink(path);
      const { agentName } = this.input;
      try {
        await db
          .insertInto('actionable_items')
          .values({
            id: randomUUID(),
            source: 'agents',
            status: 'suggested',
            kind: 'question',
            title: `${agentName} — has a question`,
            summary: clip(message, PREVIEW_CHARS),
            evidence: JSON.stringify([]),
            suggested_action: JSON.stringify({ message, form }),
            owner_subject: this.runRow.owner_subject,
            created_by: this.runRow.owner_subject,
            created_by_agent_id: this.runRow.agent_id,
            run_id: this.runRow.id,
            step_id: TURN_STEP_ID,
            iteration: 0,
            attempt: turn,
          })
          .execute();
      } catch (error) {
        if (error instanceof Error && error.message.includes('idx_actionable_items_run_step')) {
          return;
        }
        throw error;
      }
      const heading = `Agent “${agentName}” has a question`;
      await writeNotificationRow(
        db,
        {
          subject: this.runRow.owner_subject,
          agentId: this.runRow.agent_id,
          agentName,
          runId: this.runRow.id,
        },
        { kind: 'question', headline: heading, stepId: null, refUrl: path }
      );
      const prefs = await getNotificationPrefs(this.runRow.owner_subject);
      const { deliverOwnerNotifications } = notificationDeliverer(
        this.input.probe,
        this.input.toolsByName
      );
      await deliverOwnerNotifications({
        email: prefs.questionAsked.email,
        webex: prefs.questionAsked.webex,
        heading,
        body: [message, ...(link ? [`Answer here: ${link}`] : [])].join('\n\n'),
        ownerEmail: this.input.vars['user.email'],
      });
    }

    /**
     * A parked turn's re-entry. Resolved → the pause's tool_result is
     * written, the row runs again, and the loop continues its remaining
     * calls. Still pending → the run re-parks with the same deadline.
     */
    private async resolvePause(row: TurnRow): Promise<'waiting' | 'resolved'> {
      const pause = row.detail.pause;
      if (!pause) {
        await this.writeTurn(row, 'running');
        return 'resolved';
      }
      const content =
        pause.kind === 'actions'
          ? await this.resolveBatch(row, pause)
          : await this.resolveQuestion(row, pause);
      if (content === null) {
        await db
          .updateTable('agent_runs')
          .set({ status: 'waiting', updated_at: sql`NOW()` })
          .where('id', '=', this.runRow.id)
          .execute();
        return 'waiting';
      }
      row.detail.results = [
        ...(row.detail.results ?? []),
        { type: 'tool_result', toolUseId: pause.toolUseId, content },
      ];
      row.detail.pause = undefined;
      await this.writeTurn(row, 'running');
      await db
        .updateTable('agent_runs')
        .set({ status: 'running', waiting_until: null, updated_at: sql`NOW()` })
        .where('id', '=', this.runRow.id)
        .execute();
      return 'resolved';
    }

    /** The batch's report once it is settled, or null while it is not. */
    private async resolveBatch(
      row: TurnRow,
      pause: Extract<Pause, { kind: 'actions' }>
    ): Promise<string | null> {
      const batch = await db
        .selectFrom('agent_action_batches')
        .select(['id', 'status', 'actions', 'results', 'accepted_by', 'comment', 'waiting_until'])
        .where('id', '=', pause.batchId)
        .executeTakeFirst();
      if (!batch) return 'The batch could not be found; none of its actions were made.';
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the column only holds these
      let status = batch.status as ActionBatchStatus;
      let comment = batch.comment;
      let acceptedBy = batch.accepted_by;

      if (status === 'proposed') {
        const card = await db
          .selectFrom('actionable_items')
          .select(['id', 'status', 'result', 'decided_by'])
          .where('run_id', '=', this.runRow.id)
          .where('step_id', '=', TURN_STEP_ID)
          .where('attempt', '=', row.attempt)
          .executeTakeFirst();
        if (!card) {
          // A crash between the batch and its card: raise it now.
          await this.raiseBatchCard(row.attempt, batch.id, '', parseStoredActions(batch.actions));
          return null;
        }
        if (card.status === 'suggested') {
          const due = batch.waiting_until ? new Date(batch.waiting_until).getTime() : Infinity;
          if (now() < due) return null;
          const claimed = await db
            .updateTable('actionable_items')
            .set({
              status: 'expired',
              decided_at: sql`NOW()`,
              archived_at: sql`NOW()`,
              result: JSON.stringify({ reason: 'timeout' }),
              updated_at: sql`NOW()`,
            })
            .where('id', '=', card.id)
            .where('status', '=', 'suggested')
            .executeTakeFirst();
          if (Number(claimed.numUpdatedRows ?? 0) === 0) return this.resolveBatch(row, pause);
          card.status = 'expired';
        }
        comment = commentOf(card.result);
        if (card.status === 'approved') {
          status = 'accepted';
          acceptedBy = 'person';
        } else {
          status = card.status === 'declined' ? 'declined' : 'expired';
        }
        const moved = await db
          .updateTable('agent_action_batches')
          .set({
            status,
            accepted_by: acceptedBy,
            decided_by: card.decided_by,
            decided_at: sql`NOW()`,
            comment,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', batch.id)
          .where('status', '=', 'proposed')
          .executeTakeFirst();
        if (Number(moved.numUpdatedRows ?? 0) === 0) return this.resolveBatch(row, pause);
      }

      if (status === 'accepted' || status === 'executing') {
        // Handed to the executor (again, harmlessly, if the first enqueue
        // was lost — its claim is the arbiter). It wakes the run when done.
        await enqueueBatch(this.runRow, batch.id);
        await db
          .updateTable('agent_runs')
          .set({ waiting_until: null, updated_at: sql`NOW()` })
          .where('id', '=', this.runRow.id)
          .execute();
        return null;
      }
      return batchReportForAgent({
        status,
        actions: parseStoredActions(batch.actions),
        results: parseStoredResults(batch.results),
        acceptedBy: acceptedBy === 'auto' ? 'auto' : acceptedBy === 'person' ? 'person' : null,
        comment,
      });
    }

    /** The question's answer once it is in, or null while it is not. */
    private async resolveQuestion(
      row: TurnRow,
      pause: Extract<Pause, { kind: 'question' }>
    ): Promise<string | null> {
      const card = await db
        .selectFrom('actionable_items')
        .select(['id', 'status', 'result'])
        .where('run_id', '=', this.runRow.id)
        .where('step_id', '=', TURN_STEP_ID)
        .where('attempt', '=', row.attempt)
        .executeTakeFirst();
      if (!card) {
        await this.raiseQuestionCard(row.attempt, pause.message, pause.form);
        return null;
      }
      if (card.status === 'suggested') {
        const due = this.runRow.waiting_until
          ? new Date(this.runRow.waiting_until).getTime()
          : Infinity;
        if (now() < due) return null;
        const claimed = await db
          .updateTable('actionable_items')
          .set({
            status: 'expired',
            decided_at: sql`NOW()`,
            archived_at: sql`NOW()`,
            result: JSON.stringify({ reason: 'timeout' }),
            updated_at: sql`NOW()`,
          })
          .where('id', '=', card.id)
          .where('status', '=', 'suggested')
          .executeTakeFirst();
        if (Number(claimed.numUpdatedRows ?? 0) === 0) return this.resolveQuestion(row, pause);
        return 'Nobody answered before the deadline. Carry on without the answer, or finish if you cannot.';
      }
      if (card.status !== 'answered') {
        return 'The question was closed without an answer. Carry on without it, or finish if you cannot.';
      }
      return `The owner answered:\n${untrustedBlock('answer', answersForAgent(pause.form, answersOf(card.result)))}`;
    }

    private async finalizeFrom(detail: TurnDetail): Promise<void> {
      const vars: Record<string, string> = {
        ...(detail.llmSummary ? { summary: detail.llmSummary } : {}),
        ...(detail.result ? { result: detail.result } : {}),
      };
      if (detail.finish === 'failed') {
        await finalizeRun(
          this.runRow,
          'failed',
          'agent_failed',
          clip(detail.llmSummary ?? 'The agent could not reach its goal.', 2_000),
          vars
        );
      } else if (detail.finish === 'nothing_to_do') {
        await finalizeRun(this.runRow, 'stopped', null, null, vars, true);
      } else {
        await finalizeRun(this.runRow, 'succeeded', null, null, vars, detail.quiet === true);
      }
    }
  }

  /** Model spend for one turn, on the token ledger. Best effort. */
  async function recordUsage(
    run: RunRow,
    usage: UsageTotals,
    llm: ResolvedLlm,
    durationMs: number
  ): Promise<void> {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
    const ledger = await recordLlmCall(db, {
      subject: run.owner_subject,
      agentId: run.agent_id,
      runId: run.id,
      purpose: 'run',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs,
      ...(usage.cacheReadInputTokens !== null
        ? { cacheReadInputTokens: usage.cacheReadInputTokens }
        : {}),
      ...(usage.cacheWriteInputTokens !== null
        ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
        : {}),
      model: { provider: llm.providerName, model: llm.model, llmModelId: llm.modelConfigId },
    });
    if (!ledger.ok) {
      logger.warn('token usage not recorded for run {runId}', {
        component: 'worker-agents/engine',
        runId: run.id,
      });
    }
  }

  async function enqueueBatch(run: RunRow, batchId: string): Promise<void> {
    const enqueued = await deps.actionsProducer.enqueue({
      source: `agents:${run.agent_id}`,
      type: 'actions',
      payload: { batchId },
      // Its own lane: a batch must never queue behind the run waiting on it.
      orderingKey: `batch:${batchId}`,
    });
    if (!enqueued.ok) throw new TransientFailure('could not enqueue the action batch');
  }

  async function cancelWaiting(run: RunRow, reason: string): Promise<void> {
    await db
      .updateTable('agent_runs')
      .set({
        status: 'canceled',
        waiting_until: null,
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', run.id)
      .execute();
    await db
      .updateTable('actionable_items')
      .set({
        status: 'expired',
        decided_at: sql`NOW()`,
        archived_at: sql`NOW()`,
        result: JSON.stringify({ reason }),
        updated_at: sql`NOW()`,
      })
      .where('run_id', '=', run.id)
      .where('status', '=', 'suggested')
      .execute();
    // A batch nobody accepted will never run now. One already accepted is
    // the executor's to finish or refuse — it checks the run first.
    await db
      .updateTable('agent_action_batches')
      .set({ status: 'expired', updated_at: sql`NOW()` })
      .where('run_id', '=', run.id)
      .where('status', '=', 'proposed')
      .execute();
    await db
      .updateTable('agent_run_steps')
      .set({ status: 'canceled', finished_at: sql`NOW()`, updated_at: sql`NOW()` })
      .where('run_id', '=', run.id)
      .where('status', 'in', ['running', 'waiting'])
      .execute();
    await recordAgentRunOutcome(db, {
      agentId: run.agent_id,
      runId: run.id,
      ownerSubject: run.owner_subject,
      status: 'canceled',
    });
  }

  async function isCanceled(runId: string): Promise<boolean> {
    const row = await db
      .selectFrom('agent_runs')
      .select(['cancel_requested_at'])
      .where('id', '=', runId)
      .executeTakeFirst();
    return Boolean(row?.cancel_requested_at);
  }

  /** Memory + knowledge notes, rendered and bounded; '' halves on failure. */
  async function loadRunContext(
    agentId: string
  ): Promise<{ memoryText: string; knowledgeText: string }> {
    let memoryText = '';
    let knowledgeText = '';
    try {
      memoryText = renderAgentMemory(await readAgentMemory(db, agentId));
    } catch (error) {
      logger.warn('agent memory unreadable for agent {agentId}: {error}', {
        component: 'worker-agents/engine',
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      knowledgeText = await renderAgentKnowledgeNotes(db, agentId);
    } catch (error) {
      logger.warn('agent knowledge notes unreadable for agent {agentId}: {error}', {
        component: 'worker-agents/engine',
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { memoryText, knowledgeText };
  }

  /**
   * Whether a run started from outside the org's own hand (act-approval.ts).
   * A chained run inherits its ROOT's provenance; a chain that cannot be
   * walked reads as external — the fail-closed direction.
   */
  async function runIsExternallyTriggered(run: RunRow): Promise<boolean> {
    let kind = run.trigger_kind;
    let parentId = run.parent_run_id;
    for (let hops = 0; kind === 'agent' && parentId && hops < MAX_CHAIN_WALK; hops += 1) {
      const parent = await db
        .selectFrom('agent_runs')
        .select(['trigger_kind', 'parent_run_id'])
        .where('id', '=', parentId)
        .executeTakeFirst();
      if (!parent) return true;
      kind = parent.trigger_kind;
      parentId = parent.parent_run_id;
    }
    return isExternallyTriggered(kind);
  }

  /** Builtins + trigger.* from initial_state. */
  async function baseVariables(run: RunRow): Promise<Record<string, string>> {
    const vars: Record<string, string> = { today: new Date(now()).toISOString().slice(0, 10) };
    const identity = await db
      .selectFrom('identities')
      .select(['email', 'display_name'])
      .where('subject', '=', run.owner_subject)
      .executeTakeFirst();
    if (identity?.display_name) vars['user.name'] = identity.display_name;
    if (identity?.email) vars['user.email'] = identity.email;
    if (isRecord(run.initial_state)) {
      for (const [key, value] of Object.entries(run.initial_state)) {
        if (value === null || value === undefined) continue;
        vars[`trigger.${key}`] =
          typeof value === 'string' ? value : clip(JSON.stringify(value), TOOL_RESULT_CHARS);
      }
    }
    return vars;
  }

  function runPagePath(run: RunRow): string {
    return `/agents/${run.agent_id}/runs/${run.id}`;
  }

  function approvalLink(path: string | null): string | null {
    const base = getPublicBaseUrl();
    return path && base ? `${base}${path}` : null;
  }

  async function agentNameOf(agentId: string): Promise<string> {
    try {
      const row = await db
        .selectFrom('agents')
        .select('name')
        .where('id', '=', agentId)
        .executeTakeFirst();
      return row?.name?.trim() || '(unnamed agent)';
    } catch {
      return '(unknown agent)';
    }
  }

  async function finalizeRun(
    run: RunRow,
    status: 'succeeded' | 'failed' | 'stopped' | 'canceled',
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
        waiting_until: null,
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', run.id)
      .execute();
    // No turn is ever left "running" under a run that is done.
    await db
      .updateTable('agent_run_steps')
      .set({ status: 'canceled', finished_at: sql`NOW()`, updated_at: sql`NOW()` })
      .where('run_id', '=', run.id)
      .where('status', 'in', ['running', 'waiting'])
      .execute();
    const actor = await describeActor(db, run.owner_subject);
    const agentName = await agentNameOf(run.agent_id);
    const common = {
      component: 'worker-agents/engine',
      runId: run.id,
      agentId: run.agent_id,
      agentName,
      userName: actor.displayName,
      subject: actor.subject,
      status,
      errorKind: errorKind ?? undefined,
    };
    if (status === 'succeeded' || status === 'failed') {
      const notifier = await notifierFor(db, {
        subject: run.owner_subject,
        agentId: run.agent_id,
        agentName,
        runId: run.id,
        ownerEmail: undefined,
      });
      void notifier.runFinished(status, error);
    }
    if (status === 'failed') {
      logger.warn('agent "{agentName}" ({userName}) failed: {error}', {
        ...common,
        error: error ?? 'no detail recorded',
      });
    } else {
      logger.debug('agent "{agentName}" ({userName}) run {status}', common);
    }
    const logged = await recordAgentRunOutcome(db, {
      agentId: run.agent_id,
      runId: run.id,
      ownerSubject: run.owner_subject,
      status,
      errorKind,
      error,
    });
    if (!logged.ok) {
      logger.warn('run outcome not logged for run {runId}', {
        component: 'worker-agents/engine',
        runId: run.id,
      });
    }
    if (deps.onFinalized) {
      try {
        await deps.onFinalized({
          runId: run.id,
          agentId: run.agent_id,
          ownerSubject: run.owner_subject,
          status,
          errorKind,
          error,
          vars,
          quiet,
        });
      } catch (hookError) {
        logger.error('finalize hook failed for run {runId}: {error}', {
          component: 'worker-agents/engine',
          runId: run.id,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
      }
    }
  }

  // Last, on purpose: the class and consts above must be initialized
  // before the handler can run.
  return handleRun;
}

/** How a run's opening message says it started. */
function startedByText(triggerKind: string): string {
  switch (triggerKind) {
    case 'event':
      return 'An event you watch for just happened';
    case 'schedule':
      return 'Your schedule started this run';
    case 'agent':
      return 'Another agent finished and started this run';
    case 'api':
      return 'A system called you through your API trigger';
    default:
      return 'Your owner started this run by hand';
  }
}

/**
 * A turn's detail, sealed for the row (turn-detail.ts): the content
 * fields as one `uenc1:` envelope under the run OWNER's automation key,
 * the structure beside it in the clear. A seal that fails is the
 * delegation lapsing mid-run: a transient, retried by the queue rather
 * than written around in the clear.
 */
async function sealedDetailJson(
  run: Pick<RunRow, 'owner_subject'>,
  detail: Record<string, unknown>
): Promise<string> {
  const { clear, plaintext } = splitDetailForSealing(detail);
  if (plaintext === null) return JSON.stringify(clear);
  const sealed = await delegateClient().sealForSubject(
    run.owner_subject,
    [plaintext],
    'automation'
  );
  if (!sealed.ok) {
    throw new TransientFailure(`turn detail could not be sealed: ${sealed.err.type}`);
  }
  return JSON.stringify({ ...clear, sealed: sealed.val[0] });
}

/**
 * Rows with their sealed content opened as the run's owner, in one
 * delegate call. An envelope that will not open is the owner's delegation
 * lapsing: transient — a run must never continue from a conversation it
 * cannot read.
 */
async function openDetails<T extends { detail: Json | null }>(
  run: Pick<RunRow, 'owner_subject'>,
  rows: T[]
): Promise<T[]> {
  const envelopes = rows.map((row) => sealedDetailOf(row.detail));
  const stored = envelopes.flatMap((envelope) => (envelope === null ? [] : [envelope]));
  if (stored.length === 0) return rows;
  const opened = await delegateClient().openForSubject(run.owner_subject, stored);
  if (!opened.ok) {
    throw new TransientFailure(`turn detail could not be opened: ${opened.err.type}`);
  }
  let next = 0;
  return rows.map((row, index) => {
    if (envelopes[index] === null) return row;
    const plaintext = opened.val[next] ?? null;
    next += 1;
    if (plaintext === null) {
      throw new TransientFailure('turn detail could not be opened: envelope did not open');
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return { ...row, detail: mergeOpenedDetail(row.detail, plaintext, '') as Json };
  });
}
