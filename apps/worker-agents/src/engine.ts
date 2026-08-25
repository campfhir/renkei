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
  MAX_COLLECTED_ITEMS,
  findNodeById,
  flattenActionSteps,
  isAgentStepsDoc,
  renderInstruction,
  toolSegments,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  resolveTime,
  TIME_UNITS,
  type ApprovalOutcomeKey,
  type ResolveTimeRequest,
  type TimeUnit,
  type ApprovalStep,
  type BranchPath,
  type BranchStep,
  type FailureHandling,
  type LoopStep,
  type TerminalStep,
  type UntilLoopStep,
} from '@renkei/agents';
import {
  resolveAgentLlm,
  type LlmContentBlock,
  type LlmMessage,
  type LlmToolDef,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import { getOrgSettings, getPublicBaseUrl } from '@renkei/settings';
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
  ROUTER_SYSTEM_PROMPT,
  LOOP_SYSTEM_PROMPT,
  buildAttemptMessages,
  buildBranchMessages,
  buildChoosePathDef,
  buildLoopConditionMessages,
  CHOOSE_PATH_TOOL,
  FINISH_STEP_DEF,
  FINISH_STEP_TOOL,
  RESOLVE_TIME_DEF,
  RESOLVE_TIME_TOOL,
  LOOP_DECISION_DEF,
  LOOP_DECISION_TOOL,
  systemPromptWith,
} from './prompt';
import { logger } from './logger';

const NORMAL_TOOL_CAP = 3;
const CORRECTIVE_TOOL_CAP = 10;
const MAX_LLM_TURNS = 10;
const PREVIEW_CHARS = 2_000;
const DETAIL_CHARS = 60_000;
const TOKEN_SLACK_SECONDS = 15 * 60;
/** Per-entry cap on saveItems / collected list entries. */
const SAVE_ITEM_CHARS = 500;
/** Max saveItems entries one finish_step may return. */
const SAVE_ITEMS_MAX = 25;
/**
 * The run-wide execution budget: total attempt rows a run may create.
 * MAX_STEPS bounds the static plan; this bounds the RUNTIME (a loop's body
 * runs many times), together with per-loop maxIterations and the deadline.
 */
const MAX_RUN_ATTEMPT_ROWS = 250;
// Module scope on purpose: the factory returns its handler BEFORE its tail
// statements run, so hoisted functions inside it may only reference consts
// declared out here (a factory-scope const after the return stays in its
// temporal dead zone forever).
const RUN_BUDGET_ERROR = `The run exceeded its execution budget (${MAX_RUN_ATTEMPT_ROWS} step attempts).`;

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
  waiting_until: Date | null;
}

/** actionable_items decision → the approval node's outcome slot. */
function approvalOutcomeOf(decision: unknown): ApprovalOutcomeKey | null {
  if (decision === 'approved') return 'onApproved';
  if (decision === 'declined') return 'onDeclined';
  if (decision === 'expired') return 'onTimeout';
  return null;
}

/**
 * Best-effort owner notifications through the run's own MCP tools — the
 * shared arm of terminal and approval nodes. Engine-initiated and
 * owner-configured, so EXEMPT from the guardrails' blocked-tool set; an
 * unconnected or failing channel becomes a note on the attempt row, never
 * a run failure.
 */
function notificationDeliverer(mcp: McpClient, toolsByName: Map<string, McpToolInfo>) {
  const toolCalls: ToolCallRecord[] = [];
  const notes: string[] = [];
  const deliver = async (
    channel: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<void> => {
    if (!toolsByName.has(tool)) {
      notes.push(`${channel} skipped — the "${tool}" skill is not connected.`);
      return;
    }
    const startedAt = Date.now();
    let result: McpToolResult;
    try {
      result = await mcp.callTool(tool, args);
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
    toolCalls.push({
      tool,
      argsPreview: clip(JSON.stringify(args), PREVIEW_CHARS),
      resultPreview: clip(textOf(result), PREVIEW_CHARS),
      isError: result.isError,
      durationMs: Date.now() - startedAt,
    });
    if (result.isError) notes.push(`${channel} could not be delivered.`);
  };
  const deliverOwnerNotifications = async (input: {
    email: boolean;
    webex: boolean;
    heading: string;
    body: string;
    ownerEmail: string | undefined;
  }): Promise<void> => {
    if (input.email) {
      if (!input.ownerEmail) {
        notes.push('Email skipped — no email address is recorded for you.');
      } else {
        await deliver('Email', 'outlook_send_mail', {
          to: [input.ownerEmail],
          subject: input.heading,
          body: input.body,
        });
      }
    }
    if (input.webex) {
      await deliver('WebEx note', 'webex_note_to_self', {
        markdown: `**${input.heading}**\n\n${input.body}`,
      });
    }
  };
  return { toolCalls, notes, deliverOwnerNotifications };
}

interface AttemptRecord {
  step_id: string;
  attempt: number;
  status: string;
  detail: Json | null;
  iteration: number;
}

interface ToolCallRecord {
  tool: string;
  argsPreview: string;
  resultPreview: string;
  isError: boolean;
  durationMs: number;
  /**
   * An in-process call that cost no budget (resolve_time). Recorded so the
   * timeline can show what was computed, excluded from tool_call_count so
   * the number still means "calls against the step's budget".
   */
  free?: boolean;
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
  /** finish_step's saveItems, when the step saved a LIST. */
  saveItems: string[] | null;
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
  /**
   * The agent's standing guardrails, live-read from the agents row (never
   * snapshotted — tightening a rule must bite in-flight runs immediately)
   * and injected IN FULL into every model call. '' = none.
   */
  guardrailsText: string;
}

/** agents.blocked_tools jsonb → the runtime's refusal set. */
function blockedToolsOf(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  );
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
/**
 * Documents a tool attached for the model to SEE — carried in the MCP
 * result's `_meta.renkeiDocuments`, never in the text the model reads
 * (base64-as-text is transport pretending to be information). The engine
 * turns them into typed document/image content blocks the provider
 * decodes into actual pages; providers without an equivalent degrade in
 * their adapter. Only shapes the providers can render are admitted: PDFs
 * become document blocks, common raster images become image blocks,
 * anything else is dropped (its extracted text rode the tool result).
 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** At most this many attachments per attempt, and this much base64 total. */
const ATTACHMENT_MAX_BLOCKS = 3;
const ATTACHMENT_MAX_BASE64_CHARS = 14_000_000;

type AttachmentBlock = Extract<LlmContentBlock, { type: 'document' | 'image' }>;

function attachmentBlocksOfMeta(meta: Record<string, unknown>): AttachmentBlock[] {
  const raw = meta.renkeiDocuments;
  if (!Array.isArray(raw)) return [];
  const blocks: AttachmentBlock[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: { mediaType?: unknown; dataBase64?: unknown; title?: unknown } = entry;
    if (typeof record.mediaType !== 'string' || typeof record.dataBase64 !== 'string') continue;
    if (!record.dataBase64) continue;
    const title = typeof record.title === 'string' && record.title ? record.title : undefined;
    if (record.mediaType === 'application/pdf') {
      blocks.push({
        type: 'document',
        mediaType: record.mediaType,
        dataBase64: record.dataBase64,
        ...(title ? { title } : {}),
      });
    } else if (IMAGE_MEDIA_TYPES.has(record.mediaType)) {
      blocks.push({ type: 'image', mediaType: record.mediaType, dataBase64: record.dataBase64 });
    }
  }
  return blocks;
}

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

/**
 * The chosen path INDEX from a choose_path call: 'yes'/'no' on two-path
 * branches (frozen v2 wire), a 1-based number on routers. Null = not a
 * valid choice for this branch.
 */
function chosenPathIndexOf(
  input: unknown,
  pathCount: number
): { index: number; reason: string } | null {
  if (typeof input !== 'object' || input === null) return null;
  const args: { choice?: unknown; reason?: unknown } = input;
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (pathCount === 2) {
    if (args.choice === 'yes') return { index: 0, reason };
    if (args.choice === 'no') return { index: 1, reason };
    return null;
  }
  if (typeof args.choice !== 'string' || !/^\d+$/.test(args.choice)) return null;
  const index = Number(args.choice) - 1;
  if (index < 0 || index >= pathCount) return null;
  return { index, reason };
}

function loopArgsOf(input: unknown): { choice: 'finished' | 'continue'; reason: string } | null {
  if (typeof input !== 'object' || input === null) return null;
  const args: { choice?: unknown; reason?: unknown } = input;
  if (args.choice !== 'finished' && args.choice !== 'continue') return null;
  return { choice: args.choice, reason: typeof args.reason === 'string' ? args.reason : '' };
}

/**
 * One executable frame: a sibling list and the position within it. The
 * stack of frames IS the program counter — popping an exhausted frame
 * lands execution after the container block that pushed it. Loop frames
 * additionally carry the live iteration counter and (foreach) the resolved
 * item list; NOTHING here is persisted — attempt rows are the memory, and
 * a resumed run rebuilds this by fast-forwarding.
 */
interface SeqFrame {
  kind: 'seq';
  nodes: AgentStepNode[];
  index: number;
}

/**
 * A resolved approval, on its way to the path it routes into.
 *
 * `decision` and `decidedBy` exist because ROUTING ALONE IS INVISIBLE TO THE
 * MODEL. A step inside the approved path is only reachable after a human
 * approved, but the step's prompt is built from variables — and binding only
 * `approval.link` told the next step that an approval had been *requested*,
 * never that one was *given*. An agent whose owner wrote "require explicit
 * approval before creating a ticket" into its guardrails then correctly
 * refused to act, having been shown no evidence, and the run died one step
 * after the owner clicked Approve.
 */
interface ApprovalRoute {
  kind: 'route';
  outcome: ApprovalOutcomeKey;
  answer: string | null;
  link: string | null;
  /** The card's own status: 'approved' | 'declined' | 'expired'. */
  decision: string;
  /** Who decided, when the card recorded it. */
  decidedBy: string | null;
  /** ISO timestamp of the decision. */
  decidedAt: string | null;
}

interface LoopFrame {
  kind: 'loop';
  loop: LoopStep;
  nodes: AgentStepNode[];
  index: number;
  /** 1-based. */
  iteration: number;
  /** foreach: resolved once at entry (bounded by maxIterations); until: null. */
  items: string[] | null;
}

type Frame = SeqFrame | LoopFrame;

/** The innermost loop's iteration, or 0 outside any loop. */
function currentIteration(stack: Frame[]): number {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    if (frame.kind === 'loop') return frame.iteration;
  }
  return 0;
}

/**
 * The frame stack that puts `startId` on top, derived purely from where the
 * id lives in the tree — ids are doc-unique, so the ancestor chain IS the
 * record of which paths the run took. Unknown/absent id → start at the top.
 *
 * LOOPS TRUNCATE THE DESCENT: iteration counters are not persisted, so the
 * stack stops AT the first loop ancestor and execution re-enters it from
 * iteration 1 — completed iterations fast-forward through their succeeded
 * rows and recorded decisions with zero model calls, landing exactly where
 * the run stopped.
 */
function buildResumeStack(nodes: AgentStepNode[], startId: string | null): Frame[] {
  if (!startId) return [{ kind: 'seq', nodes, index: 0 }];
  const found = findNodeById(nodes, startId);
  if (!found) return [{ kind: 'seq', nodes, index: 0 }];
  const stack: Frame[] = [];
  let container = nodes;
  for (const ancestor of found.ancestors) {
    switch (ancestor.kind) {
      case 'branch': {
        const branchIndex = container.indexOf(ancestor.branch);
        // Past the branch, so popping this frame continues AFTER the block.
        stack.push({ kind: 'seq', nodes: container, index: Math.max(0, branchIndex) + 1 });
        container = ancestor.path.steps;
        break;
      }
      case 'group': {
        const groupIndex = container.indexOf(ancestor.group);
        stack.push({ kind: 'seq', nodes: container, index: Math.max(0, groupIndex) + 1 });
        container = ancestor.group.steps;
        break;
      }
      case 'approval': {
        // Branch-like: past the node, then down the outcome path the id
        // lives in — popping the path frame lands after the approval.
        const approvalIndex = container.indexOf(ancestor.approval);
        stack.push({ kind: 'seq', nodes: container, index: Math.max(0, approvalIndex) + 1 });
        container = ancestor.path.steps;
        break;
      }
      case 'loop': {
        const loopIndex = container.indexOf(ancestor.loop);
        stack.push({ kind: 'seq', nodes: container, index: Math.max(0, loopIndex) });
        return stack;
      }
      default: {
        const unhandled: never = ancestor;
        throw new Error(`unknown ancestor kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  stack.push({ kind: 'seq', nodes: found.siblings, index: found.index });
  return stack;
}

/**
 * resolve_time's arguments, narrowed field by field. Anything unusable is
 * dropped rather than coerced — resolveTime then reports precisely what was
 * wrong, and the model gets a free retry to fix it.
 */
function resolveTimeArgsOf(input: unknown): ResolveTimeRequest {
  const args: {
    timezone?: unknown;
    anchor?: unknown;
    amount?: unknown;
    unit?: unknown;
    atTime?: unknown;
    startOf?: unknown;
    endOf?: unknown;
  } = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
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

function finishArgsOf(input: unknown): {
  outcome: 'success' | 'failure' | 'nothing-to-do';
  code: string | null;
  summary: string;
  saveValue: string | null;
  saveItems: string[] | null;
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
    saveItems?: unknown;
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
  const saveItems = Array.isArray(args.saveItems)
    ? args.saveItems
        .flatMap((entry) => (typeof entry === 'string' && entry ? [entry] : []))
        .slice(0, SAVE_ITEMS_MAX)
        .map((entry) => clip(entry, SAVE_ITEM_CHARS))
    : null;
  return {
    outcome: args.outcome,
    code: typeof args.code === 'string' ? args.code : null,
    summary: typeof args.summary === 'string' ? args.summary : '',
    saveValue: typeof args.saveValue === 'string' ? args.saveValue : null,
    saveItems: saveItems && saveItems.length > 0 ? saveItems : null,
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
        'waiting_until',
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

    // The agent may have been disabled between enqueue and claim. The name
    // rides along for terminal-node notifications; guardrails and the
    // blocked-tool set are LIVE-READ here on purpose (see RunContextText).
    const agentRow = await db
      .selectFrom('agents')
      .select(['enabled', 'name', 'guardrails', 'blocked_tools'])
      .where('id', '=', run.agent_id)
      .executeTakeFirst();
    if (!agentRow) {
      await finalizeRun(run, 'failed', 'config', 'The agent no longer exists.', {});
      return;
    }
    if (!agentRow.enabled && (run.status === 'queued' || run.status === 'waiting')) {
      // An owner's approval click must not resurrect a disabled agent —
      // the waiting run cancels and its pending card (if any) archives.
      await db
        .updateTable('agent_runs')
        .set({
          status: 'canceled',
          waiting_until: null,
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', runId)
        .execute();
      await db
        .updateTable('actionable_items')
        .set({
          status: 'expired',
          decided_at: sql`NOW()`,
          archived_at: sql`NOW()`,
          result: JSON.stringify({ reason: 'agent-disabled' }),
          updated_at: sql`NOW()`,
        })
        .where('run_id', '=', runId)
        .where('status', '=', 'suggested')
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

    // A resume from a human-scale wait gets a FRESH deadline budget: the
    // pause was the owner's time, not the run's.
    const resumingFromWait = run.status === 'waiting';
    const startedAt = resumingFromWait ? new Date() : (run.started_at ?? new Date());
    if (run.status === 'queued' || resumingFromWait) {
      await db
        .updateTable('agent_runs')
        .set({
          status: 'running',
          started_at: startedAt,
          waiting_until: null,
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
        .select(['step_id', 'attempt', 'status', 'detail', 'iteration'])
        .where('run_id', '=', runId)
        // Iteration-major so a looped step's LATEST iteration wins the
        // recovered binding, matching live last-write-wins.
        .orderBy('iteration')
        .orderBy('attempt')
        .execute();
      const { vars, lists } = await baseVariables(run);
      recoverSavedVars(nodes, priorAttempts, vars, lists);
      // Steps whose saveAs feeds a loop get nudged toward saveItems.
      const loopSourceVars = new Set(
        walkSteps(nodes).flatMap(({ node }) =>
          node.kind === 'loop' && node.mode === 'foreach' ? [node.itemsVar] : []
        )
      );

      // The agent's carried context: memory (earlier runs' breadcrumbs)
      // and its own knowledge notes, both bounded at render time — the
      // read-side budget is what keeps prompts safe however large either
      // store grows. Best-effort: an unreadable memory degrades the run to
      // amnesiac, it never fails it. Guardrails ride in from the agents
      // row read above — deliberately unbounded (see RunContextText).
      const context = await loadRunContext(run);
      context.guardrailsText = agentRow.guardrails ?? '';
      const blockedTools = blockedToolsOf(agentRow.blocked_tools);

      // Crash-resume rebuilds the frame stack from where current_step_id
      // sits in the tree; a fresh run starts one frame at the top.
      const stack = buildResumeStack(nodes, run.current_step_id);

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.index >= frame.nodes.length) {
          if (frame.kind === 'loop') {
            // ITERATION BOUNDARY: the body just finished a round. Collect
            // what this iteration saved (if configured), then decide
            // whether another round runs.
            await collectIteration(run, frame, vars, lists);
            const boundary = await loopBoundary(
              run,
              frame,
              llm,
              vars,
              context,
              deadline,
              settings.agentMaxStepAttempts,
              ordinals
            );
            if (boundary.kind === 'fail') {
              await finalizeRun(run, 'failed', boundary.errorKind, boundary.error, vars);
              return;
            }
            if (boundary.kind === 'next') {
              frame.iteration += 1;
              frame.index = 0;
              if (frame.loop.mode === 'foreach' && frame.items) {
                vars[frame.loop.itemVar] = frame.items[frame.iteration - 1] ?? '';
              }
              continue;
            }
            stack.pop();
            continue;
          }
          // This sibling list is done — resume the enclosing one, which is
          // already positioned after its container block.
          stack.pop();
          continue;
        }
        const node = frame.nodes[frame.index];
        const iteration = currentIteration(stack);
        await db
          .updateTable('agent_runs')
          .set({ current_step_id: node.id, updated_at: sql`NOW()` })
          .where('id', '=', runId)
          .execute();

        // Exhaustive dispatch on the node kind: a kind this switch does not
        // handle is a compile error, never a silent fall-through into the
        // action path.
        switch (node.kind) {
          case 'branch': {
            const decided = await evaluateBranch(
              run,
              node,
              llm,
              vars,
              context,
              deadline,
              settings.agentMaxStepAttempts,
              ordinals,
              iteration
            );
            if (decided.kind === 'fail') {
              await finalizeRun(run, 'failed', decided.errorKind, decided.error, vars);
              return;
            }
            if (decided.viaFailurePath) {
              logger.warn('branch {branchId} took its failure path in run {runId}', {
                component: 'worker-agents/engine',
                runId,
                tenantId,
                branchId: node.id,
              });
            }
            // Advance past the branch FIRST, then descend — popping the path
            // frame later lands exactly after the block.
            frame.index += 1;
            stack.push({ kind: 'seq', nodes: decided.path.steps, index: 0 });
            continue;
          }
          case 'group': {
            // Pure structure: no attempt row, no model call — as if inlined.
            frame.index += 1;
            stack.push({ kind: 'seq', nodes: node.steps, index: 0 });
            continue;
          }
          case 'loop': {
            frame.index += 1;
            let items: string[] | null = null;
            if (node.mode === 'foreach') {
              items = resolveItems(node.itemsVar, vars, lists);
              if (!items || items.length === 0) {
                // Nothing to iterate is not a failure — the loop just
                // doesn't run, exactly like an empty else-path.
                logger.info('loop {loopId} skipped: "{itemsVar}" is empty in run {runId}', {
                  component: 'worker-agents/engine',
                  runId,
                  tenantId,
                  loopId: node.id,
                  itemsVar: node.itemsVar,
                });
                continue;
              }
              if (items.length > node.maxIterations) {
                logger.warn(
                  'loop {loopId} truncated: {total} item(s), processing first {cap} in run {runId}',
                  {
                    component: 'worker-agents/engine',
                    runId,
                    tenantId,
                    loopId: node.id,
                    total: items.length,
                    cap: node.maxIterations,
                  }
                );
                items = items.slice(0, node.maxIterations);
              }
              vars[node.itemVar] = items[0] ?? '';
            }
            stack.push({
              kind: 'loop',
              loop: node,
              nodes: node.steps,
              index: 0,
              iteration: 1,
              items,
            });
            continue;
          }
          case 'approval': {
            // A human-in-the-loop pause: park the run behind a card on the
            // owner's home-page feed, or — woken with the card decided or
            // expired — route the matching outcome path. Deterministic, no
            // LLM; the card's status claim is the single arbiter.
            const outcome = await executeApproval(
              run,
              node,
              agentRow.name ?? 'Your agent',
              mcp,
              toolsByName,
              vars,
              ordinals,
              iteration,
              settings.agentApprovalMaxWaitDays * 24
            );
            if (outcome.kind === 'waiting') {
              logger.info('run {runId} waiting for approval at {stepId}', {
                component: 'worker-agents/engine',
                runId,
                tenantId,
                stepId: node.id,
              });
              // Job acks; the decision route or the timeout sweep
              // re-enqueues {runId} when there is something to route.
              return;
            }
            if (outcome.link) vars['approval.link'] = outcome.link;
            // THE DECISION ITSELF, as a variable every later step's prompt
            // lists. Without this the only approval-shaped thing in scope
            // was the link — which reads as "an approval was requested",
            // the opposite of what a guardrail asking for explicit approval
            // needs to see. Phrased as a sentence rather than a bare enum
            // because it is read by a model, not switched on by code.
            vars['approval.decision'] = outcome.decision;
            vars['approval.status'] =
              outcome.decision === 'approved'
                ? `The owner approved "${node.name.trim() || 'this step'}"` +
                  (outcome.decidedBy ? ` (${outcome.decidedBy})` : '') +
                  (outcome.decidedAt ? ` at ${outcome.decidedAt}` : '') +
                  '. This run may proceed with what that approval covered.'
                : outcome.decision === 'declined'
                  ? `The owner DECLINED "${node.name.trim() || 'this step'}". Do not carry out what was declined.`
                  : `Nobody answered "${node.name.trim() || 'this step'}" before the deadline. Treat it as not approved.`;
            if (outcome.decidedBy) vars['approval.decidedBy'] = outcome.decidedBy;
            if (outcome.decidedAt) vars['approval.decidedAt'] = outcome.decidedAt;
            if (node.mode === 'input' && node.saveAs && outcome.answer !== null) {
              vars[node.saveAs] = outcome.answer;
            }
            frame.index += 1;
            stack.push({ kind: 'seq', nodes: node[outcome.outcome].steps, index: 0 });
            continue;
          }
          case 'terminal': {
            // An explicit end marker: the run ends HERE with the configured
            // result — inside a branch path or loop body too — after the
            // node's own notifications go out. Deterministic, no LLM.
            const ended = await executeTerminal(
              run,
              node,
              agentRow.name ?? 'Your agent',
              mcp,
              toolsByName,
              vars,
              ordinals,
              iteration
            );
            switch (node.result) {
              case 'failure':
                // quiet=true: the node's OWN channels are the notification
                // now — the generic context-free run.failed mail must not
                // double up on an ending the owner configured explicitly.
                await finalizeRun(
                  run,
                  'failed',
                  'step_failed',
                  `The flow ended at "${node.name || 'a failure marker'}"${ended.message ? `: ${clip(ended.message, 300)}` : '.'}`,
                  vars,
                  true
                );
                return;
              case 'stop':
                await finalizeRun(run, 'stopped', null, null, vars, true);
                return;
              case 'success':
                // Not quiet: a successful finish still chains dependent
                // agents, exactly like reaching the end of the list.
                await finalizeRun(run, 'succeeded', null, null, vars);
                return;
              default: {
                const unhandled: never = node.result;
                throw new Error(`unknown terminal result: ${JSON.stringify(unhandled)}`);
              }
            }
          }
          case 'action':
          case undefined:
            break;
          default: {
            const unhandled: never = node;
            throw new Error(`unknown step kind in snapshot: ${JSON.stringify(unhandled)}`);
          }
        }

        const result = await executeStep(
          run,
          node,
          toolsByName,
          llm,
          mcp,
          vars,
          lists,
          loopSourceVars,
          context,
          blockedTools,
          deadline,
          settings.agentMaxStepAttempts,
          ordinals,
          iteration
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
    // guardrailsText is filled by the caller from the agents row it
    // already read — one query, not two.
    return { memoryText, knowledgeText, guardrailsText: '' };
  }

  /** Builtins + trigger.* from initial_state; list-valued inputs also land in `lists`. */
  async function baseVariables(
    run: RunRow
  ): Promise<{ vars: Record<string, string>; lists: Record<string, string[]> }> {
    const vars: Record<string, string> = {
      today: new Date().toISOString().slice(0, 10),
    };
    const lists: Record<string, string[]> = {};
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
        if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
          lists[`trigger.${key}`] = value.map((entry) => clip(entry, SAVE_ITEM_CHARS));
        }
      }
    }
    return { vars, lists };
  }

  function recoverSavedVars(
    nodes: AgentStepNode[],
    prior: AttemptRecord[],
    vars: Record<string, string>,
    lists: Record<string, string[]>
  ): void {
    // Action steps AND approval nodes bind saveAs — an answered card's
    // binding must survive crash-resume like any other saved result.
    const saveAsByStep = new Map([
      ...flattenActionSteps(nodes).flatMap((step) =>
        step.saveAs ? [[step.id, step.saveAs] as const] : []
      ),
      ...walkSteps(nodes).flatMap(({ node }) =>
        node.kind === 'approval' && node.saveAs ? [[node.id, node.saveAs] as const] : []
      ),
    ]);
    for (const attempt of prior) {
      if (attempt.status !== 'succeeded') continue;
      const name = saveAsByStep.get(attempt.step_id);
      if (!name) continue;
      const detail: { saveValue?: unknown; saveItems?: unknown } =
        typeof attempt.detail === 'object' &&
        attempt.detail !== null &&
        !Array.isArray(attempt.detail)
          ? attempt.detail
          : {};
      if (Array.isArray(detail.saveItems) && detail.saveItems.every((e) => typeof e === 'string')) {
        lists[name] = detail.saveItems;
        vars[name] = detail.saveItems.join('\n');
      } else if (typeof detail.saveValue === 'string') {
        vars[name] = detail.saveValue;
      }
    }
  }

  /** The foreach source list: a saved list, or a JSON-array string fallback. */
  function resolveItems(
    itemsVar: string,
    vars: Record<string, string>,
    lists: Record<string, string[]>
  ): string[] | null {
    const direct = lists[itemsVar];
    if (direct) return [...direct];
    const raw = vars[itemsVar];
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
        return parsed.map((entry) => clip(entry, SAVE_ITEM_CHARS));
      }
    } catch {
      // Not JSON — fall through.
    }
    return null;
  }

  /**
   * Append what THIS iteration's collectFrom step actually saved to the
   * loop's collected list — nothing (a filtering iteration), one saveValue,
   * or every saveItems entry (an expanding one). Read from the iteration's
   * attempt row, never from the flat vars record, so a skipped iteration
   * can't smuggle in a stale value. Rows are the memory: a resumed run
   * rebuilds the whole collection by crossing these boundaries again.
   */
  async function collectIteration(
    run: RunRow,
    frame: LoopFrame,
    vars: Record<string, string>,
    lists: Record<string, string[]>
  ): Promise<void> {
    const { collectFrom, collectVar } = frame.loop;
    if (!collectFrom || !collectVar) return;
    const source = flattenActionSteps(frame.loop.steps).find((step) => step.saveAs === collectFrom);
    if (!source) return;

    const row = await db
      .selectFrom('agent_run_steps')
      .select('detail')
      .where('run_id', '=', run.id)
      .where('step_id', '=', source.id)
      .where('iteration', '=', frame.iteration)
      .where('status', '=', 'succeeded')
      .executeTakeFirst();
    if (!row) return;
    const detail: { saveValue?: unknown; saveItems?: unknown } =
      typeof row.detail === 'object' && row.detail !== null && !Array.isArray(row.detail)
        ? row.detail
        : {};
    const additions = Array.isArray(detail.saveItems)
      ? detail.saveItems.flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
      : typeof detail.saveValue === 'string'
        ? [detail.saveValue]
        : [];
    if (additions.length === 0) return;

    const current = lists[collectVar] ?? [];
    const room = MAX_COLLECTED_ITEMS - current.length;
    if (room <= 0) return;
    if (additions.length > room) {
      logger.warn('collected list "{collectVar}" truncated at {cap} entries in run {runId}', {
        component: 'worker-agents/engine',
        runId: run.id,
        tenantId: run.tenant_id,
        collectVar,
        cap: MAX_COLLECTED_ITEMS,
      });
    }
    lists[collectVar] = [
      ...current,
      ...additions.slice(0, room).map((entry) => clip(entry, SAVE_ITEM_CHARS)),
    ];
    vars[collectVar] = lists[collectVar].join('\n');
  }

  /**
   * What happens after an iteration finishes: foreach counts items; until
   * asks the model (via evaluateLoopCondition, with per-iteration decision
   * rows and replay). 'next' = run another round; 'done' = continue after
   * the loop; reaching maxIterations with an unmet until-condition FAILS
   * the run — the guard is a tripwire for a premise that never came true.
   */
  async function loopBoundary(
    run: RunRow,
    frame: LoopFrame,
    llm: ResolvedLlm,
    vars: Record<string, string>,
    context: RunContextText,
    deadline: number,
    orgAttemptCap: number,
    ordinals: Map<string, number>
  ): Promise<
    { kind: 'next' } | { kind: 'done' } | { kind: 'fail'; errorKind: string; error: string }
  > {
    if (frame.loop.mode === 'foreach') {
      const total = frame.items?.length ?? 0;
      return frame.iteration >= total ? { kind: 'done' } : { kind: 'next' };
    }
    const decided = await evaluateLoopCondition(
      run,
      frame.loop,
      frame.iteration,
      llm,
      vars,
      context,
      deadline,
      orgAttemptCap,
      ordinals
    );
    if (decided.kind === 'fail') return decided;
    if (decided.choice === 'finished') return { kind: 'done' };
    if (frame.iteration >= frame.loop.maxIterations) {
      return {
        kind: 'fail',
        errorKind: 'step_failed',
        error: `Loop "${frame.loop.name}" reached its limit of ${frame.loop.maxIterations} round${frame.loop.maxIterations === 1 ? '' : 's'} before its stop condition was met.`,
      };
    }
    return { kind: 'next' };
  }

  /** The run-wide execution budget check, before each attempt-row insert. */
  async function runBudgetExceeded(runId: string): Promise<boolean> {
    const counted = await db
      .selectFrom('agent_run_steps')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return Number(counted?.count ?? 0) >= MAX_RUN_ATTEMPT_ROWS;
  }

  async function executeStep(
    run: RunRow,
    step: ActionStep,
    toolsByName: Map<string, McpToolInfo>,
    llm: ResolvedLlm,
    mcp: McpClient,
    vars: Record<string, string>,
    lists: Record<string, string[]>,
    loopSourceVars: ReadonlySet<string>,
    context: RunContextText,
    blockedTools: ReadonlySet<string>,
    deadline: number,
    orgAttemptCap: number,
    ordinals: Map<string, number>,
    iteration: number
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
    // Guardrails' mechanical arm: a blocked skill fails the run as a guard
    // stop, live — a rule added mid-flight bites the very next step. The
    // validator catches this at save; runtime is the backstop.
    if (step.tool && blockedTools.has(step.tool)) {
      return {
        kind: 'fail',
        errorKind: 'guard',
        error: `The skill "${step.tool}" is blocked by this agent's guardrails.`,
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
      // Close an attempt a crashed worker left open, then recount. All
      // bookkeeping is scoped to THIS iteration — a looped step's budget
      // and its succeeded-short-circuit are per round, or a loop would
      // run its body once and skip every later round.
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
        .where('iteration', '=', iteration)
        .where('status', '=', 'running')
        .execute();

      const counted = await db
        .selectFrom('agent_run_steps')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('run_id', '=', run.id)
        .where('step_id', '=', step.id)
        .where('iteration', '=', iteration)
        .executeTakeFirst();
      const attemptsUsed = Number(counted?.count ?? 0);

      // Advance past a step that already succeeded (resume/fast-forward).
      const succeeded = await db
        .selectFrom('agent_run_steps')
        .select('id')
        .where('run_id', '=', run.id)
        .where('step_id', '=', step.id)
        .where('iteration', '=', iteration)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      if (succeeded) return { kind: 'advance' };

      const onIteration = iteration > 0 ? ` on round ${iteration}` : '';
      if (attemptsUsed >= budget) {
        return {
          kind: 'fail',
          errorKind: 'step_failed',
          error: `Step "${step.name}" failed after ${attemptsUsed} attempt${attemptsUsed === 1 ? '' : 's'}${onIteration}${lastFailureCode ? ` (${lastFailureCode})` : ''}.`,
        };
      }
      if (Date.now() > deadline) {
        return { kind: 'fail', errorKind: 'timeout', error: 'The run exceeded its time budget.' };
      }
      if (await runBudgetExceeded(run.id)) {
        return { kind: 'fail', errorKind: 'guard', error: RUN_BUDGET_ERROR };
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
            iteration,
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
          context,
          blockedTools,
          iteration,
          Boolean(step.saveAs && loopSourceVars.has(step.saveAs))
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
        ...(outcome.saveItems !== null ? { saveItems: outcome.saveItems } : {}),
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
          tool_call_count: outcome.toolCalls.filter((call) => !call.free).length,
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
        if (step.saveAs && outcome.saveItems !== null) {
          // A saved LIST: bind both representations — the list for loops,
          // the joined text for var chips.
          lists[step.saveAs] = outcome.saveItems;
          vars[step.saveAs] = outcome.saveItems.join('\n');
        } else if (step.saveAs && outcome.saveValue !== null) {
          vars[step.saveAs] = outcome.saveValue;
        }
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
   * Execute a terminal node: record its attempt row and deliver its
   * configured notifications through the run's own MCP client — the same
   * owner-granted tools the steps use (`outlook_send_mail` to the owner's
   * own address, `webex_note_to_self`), so the message carries the run's
   * real variable values instead of the old context-free failure mail.
   *
   * Deterministic and best-effort: no LLM is involved, and a channel that
   * is unconnected or errors becomes a note on the attempt row, never a
   * run failure — the ending itself is what the node is for. Redelivery
   * replays: an existing terminal row for this iteration means the
   * notifications already went out, so they are not re-sent.
   */
  async function executeTerminal(
    run: RunRow,
    node: TerminalStep,
    agentName: string,
    mcp: McpClient,
    toolsByName: Map<string, McpToolInfo>,
    vars: Record<string, string>,
    ordinals: Map<string, number>,
    iteration: number
  ): Promise<{ message: string }> {
    const rendered = renderInstruction(node.message, vars);
    const message = rendered.text.trim();

    // Close a row a crashed worker left open, then replay a finished one.
    await db
      .updateTable('agent_run_steps')
      .set({
        status: 'failed',
        outcome: 'terminal',
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('run_id', '=', run.id)
      .where('step_id', '=', node.id)
      .where('iteration', '=', iteration)
      .where('status', '=', 'running')
      .execute();
    const existing = await db
      .selectFrom('agent_run_steps')
      .select('id')
      .where('run_id', '=', run.id)
      .where('step_id', '=', node.id)
      .where('iteration', '=', iteration)
      .where('status', 'in', ['succeeded', 'failed', 'stopped'])
      .executeTakeFirst();
    if (existing) return { message };

    const counted = await db
      .selectFrom('agent_run_steps')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('run_id', '=', run.id)
      .where('step_id', '=', node.id)
      .where('iteration', '=', iteration)
      .executeTakeFirst();
    const rowId = randomUUID();
    try {
      await db
        .insertInto('agent_run_steps')
        .values({
          id: rowId,
          tenant_id: run.tenant_id,
          run_id: run.id,
          step_id: node.id,
          step_index: ordinals.get(node.id) ?? 0,
          attempt: Number(counted?.count ?? 0) + 1,
          iteration,
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

    const resultPhrase =
      node.result === 'failure'
        ? 'stopped at a failure marker'
        : node.result === 'stop'
          ? 'finished — nothing to do'
          : 'finished';
    const heading = `Agent “${agentName}” ${resultPhrase}${node.name.trim() ? `: ${node.name.trim()}` : ''}`;
    const { toolCalls, notes, deliverOwnerNotifications } = notificationDeliverer(mcp, toolsByName);
    await deliverOwnerNotifications({
      email: node.notifyEmail,
      webex: node.notifyWebex,
      heading,
      body: message || heading,
      ownerEmail: vars['user.email'],
    });

    const detail = {
      llmSummary: [`The flow ended here (${resultPhrase}).`, ...notes].join(' '),
      declaredOutcome:
        node.result === 'failure'
          ? 'failure'
          : node.result === 'stop'
            ? 'nothing-to-do'
            : 'success',
      terminalResult: node.result,
      ...(message ? { terminalMessage: clip(message, PREVIEW_CHARS) } : {}),
      ...(rendered.unbound.length > 0 ? { unboundVariables: rendered.unbound } : {}),
      toolCalls,
    };
    // The row's status mirrors the run's ending, so the timeline never
    // shows a green pill at the node that failed the run on purpose (the
    // same reasoning as the stop-quiet failure handling above).
    await db
      .updateTable('agent_run_steps')
      .set({
        status:
          node.result === 'failure' ? 'failed' : node.result === 'stop' ? 'stopped' : 'succeeded',
        outcome: 'terminal',
        outcome_code: null,
        tool_call_count: toolCalls.length,
        detail: clip(JSON.stringify(detail), DETAIL_CHARS),
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', rowId)
      .execute();
    return { message };
  }

  /** The owner-facing run link approval cards and notifications carry. */
  async function approvalLink(run: RunRow): Promise<string | null> {
    const base = getPublicBaseUrl();
    if (!base) return null;
    const tenant = await db
      .selectFrom('tenants')
      .select('slug')
      .where('id', '=', run.tenant_id)
      .executeTakeFirst();
    return tenant ? `${base}/${tenant.slug}/agents/${run.agent_id}/runs/${run.id}` : null;
  }

  /**
   * Execute an approval node. On first arrival: insert a 'waiting' attempt
   * row, create the interactive card on the OWNER's home-page feed, send
   * the configured notifications (message + link, via the run's own MCP
   * tools), park the run as status='waiting' with a concrete deadline, and
   * ACK the job — nothing polls; the decision route and the timeout sweep
   * re-enqueue {runId} when there is something to route.
   *
   * On a wake: the CARD IS THE SINGLE ARBITER. Decided → resolve the
   * waiting row and route the matching outcome path. Suggested past the
   * deadline → claim expiry through the same optimistic status UPDATE the
   * decision route uses (a lost claim means a human decided in the same
   * instant — their decision wins). Suggested and not yet due → re-park
   * with the SAME deadline (a spurious wake never extends the wait).
   * Already-resolved attempt rows replay without touching the card at all,
   * so archived or retention-pruned cards cannot re-route history.
   */
  async function executeApproval(
    run: RunRow,
    node: ApprovalStep,
    agentName: string,
    mcp: McpClient,
    toolsByName: Map<string, McpToolInfo>,
    vars: Record<string, string>,
    ordinals: Map<string, number>,
    iteration: number,
    waitCapHours: number
  ): Promise<{ kind: 'waiting' } | ApprovalRoute> {
    const link = await approvalLink(run);

    // Replay: crash-after-resolve-before-advance, and history whose card
    // is long archived or pruned.
    const resolved = await db
      .selectFrom('agent_run_steps')
      .select('detail')
      .where('run_id', '=', run.id)
      .where('step_id', '=', node.id)
      .where('iteration', '=', iteration)
      .where('status', '=', 'succeeded')
      .executeTakeFirst();
    if (resolved) {
      const detail: {
        decision?: unknown;
        saveValue?: unknown;
        decidedBy?: unknown;
        decidedAt?: unknown;
      } =
        typeof resolved.detail === 'object' &&
        resolved.detail !== null &&
        !Array.isArray(resolved.detail)
          ? resolved.detail
          : {};
      const outcome = approvalOutcomeOf(detail.decision);
      if (outcome) {
        return {
          kind: 'route',
          outcome,
          answer: typeof detail.saveValue === 'string' ? detail.saveValue : null,
          link,
          // Replay must rebind the same evidence the first pass did, or a
          // resumed run reaches the approved path having forgotten why.
          decision: typeof detail.decision === 'string' ? detail.decision : 'approved',
          decidedBy: typeof detail.decidedBy === 'string' ? detail.decidedBy : null,
          decidedAt: typeof detail.decidedAt === 'string' ? detail.decidedAt : null,
        };
      }
    }

    const clampedHours = Math.min(Math.max(1, node.timeoutHours), Math.max(1, waitCapHours));
    const card = await db
      .selectFrom('actionable_items')
      .select(['id', 'status', 'result', 'created_at'])
      .where('run_id', '=', run.id)
      .where('step_id', '=', node.id)
      .where('iteration', '=', iteration)
      .executeTakeFirst();

    // Resolve a decided/expired card: update the waiting row in place to
    // 'succeeded' (all three outcomes ROUTE onward — run-ending semantics
    // belong to terminal nodes placed inside the paths) and hand back the
    // route. detail.decision is what replay re-derives from.
    const resolveDecision = async (status: string, result: unknown): Promise<ApprovalRoute> => {
      const outcome = approvalOutcomeOf(status) ?? 'onTimeout';
      const resultObj: { answer?: unknown; decidedBy?: unknown } =
        typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {};
      const answer =
        node.mode === 'input' && typeof resultObj.answer === 'string' && resultObj.answer.trim()
          ? resultObj.answer.trim()
          : null;
      const wording =
        status === 'approved'
          ? node.mode === 'input'
            ? 'You answered.'
            : 'You approved.'
          : status === 'declined'
            ? 'You declined.'
            : 'Nobody answered in time.';
      const decidedBy = typeof resultObj.decidedBy === 'string' ? resultObj.decidedBy : null;
      const decidedAt = new Date().toISOString();
      const detail = {
        llmSummary: wording,
        declaredOutcome: 'success',
        decision: approvalOutcomeOf(status) ? status : 'expired',
        // Persisted so replay rebinds identical evidence — see ApprovalRoute.
        ...(decidedBy !== null ? { decidedBy } : {}),
        decidedAt,
        ...(answer !== null ? { saveValue: clip(answer, PREVIEW_CHARS) } : {}),
      };
      const updated = await db
        .updateTable('agent_run_steps')
        .set({
          status: 'succeeded',
          outcome: 'approval',
          outcome_code: null,
          detail: clip(JSON.stringify(detail), DETAIL_CHARS),
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('run_id', '=', run.id)
        .where('step_id', '=', node.id)
        .where('iteration', '=', iteration)
        .where('status', '=', 'waiting')
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) === 0) {
        // No waiting row (a crash between card insert and row insert, or a
        // historical anomaly) — record the resolution as a fresh row so the
        // timeline and replay both have it.
        const counted = await db
          .selectFrom('agent_run_steps')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .where('run_id', '=', run.id)
          .where('step_id', '=', node.id)
          .where('iteration', '=', iteration)
          .executeTakeFirst();
        await db
          .insertInto('agent_run_steps')
          .values({
            id: randomUUID(),
            tenant_id: run.tenant_id,
            run_id: run.id,
            step_id: node.id,
            step_index: ordinals.get(node.id) ?? 0,
            attempt: Number(counted?.count ?? 0) + 1,
            iteration,
            status: 'succeeded',
            outcome: 'approval',
            detail: clip(JSON.stringify(detail), DETAIL_CHARS),
            started_at: sql`NOW()`,
            finished_at: sql`NOW()`,
          })
          .execute();
      }
      return {
        kind: 'route',
        outcome,
        answer,
        link,
        decision: approvalOutcomeOf(status) ? status : 'expired',
        decidedBy,
        decidedAt,
      };
    };

    if (card && card.status !== 'suggested') {
      return resolveDecision(card.status, card.result);
    }

    if (card) {
      // Undecided. Past the deadline → claim expiry (single arbiter); not
      // yet due → re-park with the SAME deadline.
      const dueAt = run.waiting_until
        ? new Date(run.waiting_until).getTime()
        : new Date(card.created_at).getTime() + clampedHours * 3_600_000;
      if (Date.now() >= dueAt) {
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
        if (Number(claimed.numUpdatedRows ?? 0) === 0) {
          // Lost the claim — a human decided in the same instant.
          const decided = await db
            .selectFrom('actionable_items')
            .select(['status', 'result'])
            .where('id', '=', card.id)
            .executeTakeFirst();
          return resolveDecision(decided?.status ?? 'expired', decided?.result ?? null);
        }
        return resolveDecision('expired', { reason: 'timeout' });
      }
      await db
        .updateTable('agent_runs')
        .set({ status: 'waiting', waiting_until: new Date(dueAt), updated_at: sql`NOW()` })
        .where('id', '=', run.id)
        .execute();
      return { kind: 'waiting' };
    }

    // FRESH PAUSE. The waiting attempt row first (the unique-constraint
    // tripwire for racing executors), then the card, notifications, park.
    const existingWaiting = await db
      .selectFrom('agent_run_steps')
      .select('id')
      .where('run_id', '=', run.id)
      .where('step_id', '=', node.id)
      .where('iteration', '=', iteration)
      .where('status', '=', 'waiting')
      .executeTakeFirst();
    let rowId = existingWaiting?.id ?? null;
    if (!rowId) {
      const counted = await db
        .selectFrom('agent_run_steps')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('run_id', '=', run.id)
        .where('step_id', '=', node.id)
        .where('iteration', '=', iteration)
        .executeTakeFirst();
      rowId = randomUUID();
      try {
        await db
          .insertInto('agent_run_steps')
          .values({
            id: rowId,
            tenant_id: run.tenant_id,
            run_id: run.id,
            step_id: node.id,
            step_index: ordinals.get(node.id) ?? 0,
            attempt: Number(counted?.count ?? 0) + 1,
            iteration,
            status: 'waiting',
            started_at: sql`NOW()`,
          })
          .execute();
      } catch (error) {
        if (error instanceof Error && error.message.includes('agent_run_steps_attempt')) {
          throw new TransientFailure('another executor holds this run');
        }
        throw error;
      }
    }

    const rendered = renderInstruction(node.message, vars);
    const message =
      rendered.text.trim() ||
      node.name.trim() ||
      (node.mode === 'input' ? 'An agent needs your answer.' : 'An agent needs your approval.');
    const waitingUntil = new Date(Date.now() + clampedHours * 3_600_000);
    try {
      await db
        .insertInto('actionable_items')
        .values({
          id: randomUUID(),
          tenant_id: run.tenant_id,
          source: 'agents',
          status: 'suggested',
          kind: 'approval',
          title: `${agentName} — ${node.name.trim() || (node.mode === 'input' ? 'needs your answer' : 'needs your approval')}`,
          summary: clip(message, PREVIEW_CHARS),
          evidence: JSON.stringify([]),
          // Not an executable action: the card UI reads the MODE here to
          // render approve/decline buttons vs an answer box.
          suggested_action: JSON.stringify({ approvalMode: node.mode }),
          owner_subject: run.owner_subject,
          created_by: run.owner_subject,
          created_by_agent_id: run.agent_id,
          run_id: run.id,
          step_id: node.id,
          iteration,
        })
        .execute();
    } catch (error) {
      // The unique (run, step, iteration) card index: a racing executor won
      // — its card (and notification) stand; back off and re-enter.
      if (error instanceof Error && error.message.includes('idx_actionable_items_run_step')) {
        throw new TransientFailure('another executor created the approval card');
      }
      throw error;
    }

    // First pause only — a re-parked wake never re-notifies.
    vars['approval.link'] = link ?? '';
    const { toolCalls, notes, deliverOwnerNotifications } = notificationDeliverer(mcp, toolsByName);
    await deliverOwnerNotifications({
      email: node.notifyEmail,
      webex: node.notifyWebex,
      heading: `Agent “${agentName}” is waiting for you${node.name.trim() ? `: ${node.name.trim()}` : ''}`,
      body: [message, ...(link ? [`Respond here: ${link}`] : [])].join('\n\n'),
      ownerEmail: vars['user.email'],
    });

    const waitingDetail = {
      llmSummary: [`Waiting for you (until ${waitingUntil.toISOString()}).`, ...notes].join(' '),
      approvalMessage: clip(message, PREVIEW_CHARS),
      ...(rendered.unbound.length > 0 ? { unboundVariables: rendered.unbound } : {}),
      toolCalls,
    };
    await db
      .updateTable('agent_run_steps')
      .set({
        outcome: 'approval',
        tool_call_count: toolCalls.length,
        detail: clip(JSON.stringify(waitingDetail), DETAIL_CHARS),
        updated_at: sql`NOW()`,
      })
      .where('id', '=', rowId)
      .execute();

    await db
      .updateTable('agent_runs')
      .set({ status: 'waiting', waiting_until: waitingUntil, updated_at: sql`NOW()` })
      .where('id', '=', run.id)
      .execute();
    return { kind: 'waiting' };
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
    ordinals: Map<string, number>,
    iteration: number
  ): Promise<
    | { kind: 'path'; path: BranchPath; viaFailurePath?: boolean }
    | { kind: 'fail'; errorKind: string; error: string }
  > {
    const pathById = (id: string | undefined): BranchPath | null => {
      for (const path of branch.paths) if (path.id === id) return path;
      if (branch.failurePath && branch.failurePath.id === id) return branch.failurePath;
      return null;
    };

    const budget = Math.min(branch.maxAttempts, Math.max(1, orgAttemptCap));
    let lastFailureSummary: string | undefined;

    for (;;) {
      // Close an evaluation a crashed worker left open, then recount —
      // scoped to this iteration, so a branch inside a loop decides FRESH
      // each round while redelivery within a round still replays.
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
        .where('iteration', '=', iteration)
        .where('status', '=', 'running')
        .execute();

      // Redelivery/resume: an already-decided branch is not re-asked.
      const succeeded = await db
        .selectFrom('agent_run_steps')
        .select('detail')
        .where('run_id', '=', run.id)
        .where('step_id', '=', branch.id)
        .where('iteration', '=', iteration)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      if (succeeded) {
        const detail: { chosenPathId?: unknown; viaFailurePath?: unknown } =
          typeof succeeded.detail === 'object' &&
          succeeded.detail !== null &&
          !Array.isArray(succeeded.detail)
            ? succeeded.detail
            : {};
        const chosen =
          typeof detail.chosenPathId === 'string' ? pathById(detail.chosenPathId) : null;
        if (chosen) {
          return {
            kind: 'path',
            path: chosen,
            ...(detail.viaFailurePath === true ? { viaFailurePath: true } : {}),
          };
        }
        // Unreadable choice: fall through and re-evaluate under whatever
        // budget the counted rows leave.
      }

      const counted = await db
        .selectFrom('agent_run_steps')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('run_id', '=', run.id)
        .where('step_id', '=', branch.id)
        .where('iteration', '=', iteration)
        .executeTakeFirst();
      const attemptsUsed = Number(counted?.count ?? 0);

      if (attemptsUsed >= budget) {
        // Evaluation exhausted its attempts. With a failure path configured
        // this is the STRUCTURAL exit, not a run failure: the automation
        // routes there instead (an empty failure path just continues after
        // the branch). Deterministic on resume too — re-counting lands
        // here again.
        if (branch.failurePath) {
          logger.warn('branch {branchId} evaluation exhausted; taking failure path', {
            component: 'worker-agents/engine',
            runId: run.id,
            tenantId: run.tenant_id,
            branchId: branch.id,
          });
          return { kind: 'path', path: branch.failurePath, viaFailurePath: true };
        }
        return {
          kind: 'fail',
          errorKind: 'step_failed',
          error: `Branch "${branch.name}" could not be decided after ${attemptsUsed} attempt${attemptsUsed === 1 ? '' : 's'}${lastFailureSummary ? `: ${clip(lastFailureSummary, 300)}` : '.'}`,
        };
      }
      if (Date.now() > deadline) {
        return { kind: 'fail', errorKind: 'timeout', error: 'The run exceeded its time budget.' };
      }
      if (await runBudgetExceeded(run.id)) {
        return { kind: 'fail', errorKind: 'guard', error: RUN_BUDGET_ERROR };
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
            iteration,
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
        ...(context.guardrailsText ? { guardrailsText: context.guardrailsText } : {}),
      });
      const resolvedInstruction = renderInstruction(branch.condition, vars).text;
      const messages: LlmMessage[] = [...built.messages];
      const usage = { inputTokens: 0, outputTokens: 0 };
      let failureSummary = 'The model never chose a path.';

      let decidedPath: BranchPath | null = null;
      let decidedReason = '';
      const choosePathDef = buildChoosePathDef(branch);
      const branchSystem = branch.paths.length === 2 ? BRANCH_SYSTEM_PROMPT : ROUTER_SYSTEM_PROMPT;
      // A short turn cap: forced choose_path should answer immediately; one
      // nudge covers a model that answered in prose first.
      for (let turn = 0; turn < 3 && !decidedPath; turn += 1) {
        const completion = await llm.provider.complete({
          system: branchSystem,
          messages,
          tools: [choosePathDef],
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
        const choice = chooseUse ? chosenPathIndexOf(chooseUse.input, branch.paths.length) : null;
        if (chooseUse && choice) {
          decidedPath = branch.paths[choice.index];
          decidedReason = choice.reason;
          break;
        }
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                branch.paths.length === 2
                  ? 'Call choose_path exactly once with {choice: "yes" | "no", reason}.'
                  : `Call choose_path exactly once with {choice: "1"–"${branch.paths.length}", reason}.`,
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

  /**
   * Decide an until-loop's stop condition after an iteration — the loop
   * sibling of evaluateBranch, with identical bookkeeping: per-iteration
   * attempt rows keyed on the LOOP's id, budget by counting rows, the
   * unique-constraint tripwire, deadline, and decision replay (a decided
   * iteration is never re-asked).
   */
  async function evaluateLoopCondition(
    run: RunRow,
    loop: UntilLoopStep,
    iteration: number,
    llm: ResolvedLlm,
    vars: Record<string, string>,
    context: RunContextText,
    deadline: number,
    orgAttemptCap: number,
    ordinals: Map<string, number>
  ): Promise<
    | { kind: 'decided'; choice: 'finished' | 'continue' }
    | { kind: 'fail'; errorKind: string; error: string }
  > {
    const budget = Math.min(loop.maxAttempts, Math.max(1, orgAttemptCap));
    let lastFailureSummary: string | undefined;

    for (;;) {
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
        .where('step_id', '=', loop.id)
        .where('iteration', '=', iteration)
        .where('status', '=', 'running')
        .execute();

      // Replay: this iteration's decision, if already made.
      const succeeded = await db
        .selectFrom('agent_run_steps')
        .select('detail')
        .where('run_id', '=', run.id)
        .where('step_id', '=', loop.id)
        .where('iteration', '=', iteration)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      if (succeeded) {
        const detail: { loopDecision?: unknown } =
          typeof succeeded.detail === 'object' &&
          succeeded.detail !== null &&
          !Array.isArray(succeeded.detail)
            ? succeeded.detail
            : {};
        if (detail.loopDecision === 'finished' || detail.loopDecision === 'continue') {
          return { kind: 'decided', choice: detail.loopDecision };
        }
      }

      const counted = await db
        .selectFrom('agent_run_steps')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('run_id', '=', run.id)
        .where('step_id', '=', loop.id)
        .where('iteration', '=', iteration)
        .executeTakeFirst();
      const attemptsUsed = Number(counted?.count ?? 0);

      if (attemptsUsed >= budget) {
        return {
          kind: 'fail',
          errorKind: 'step_failed',
          error: `Loop "${loop.name}" could not decide its stop condition after ${attemptsUsed} attempt${attemptsUsed === 1 ? '' : 's'} on round ${iteration}${lastFailureSummary ? `: ${clip(lastFailureSummary, 300)}` : '.'}`,
        };
      }
      if (Date.now() > deadline) {
        return { kind: 'fail', errorKind: 'timeout', error: 'The run exceeded its time budget.' };
      }
      if (await runBudgetExceeded(run.id)) {
        return { kind: 'fail', errorKind: 'guard', error: RUN_BUDGET_ERROR };
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
            step_id: loop.id,
            step_index: ordinals.get(loop.id) ?? 0,
            attempt,
            iteration,
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

      const built = buildLoopConditionMessages({
        loop,
        iteration,
        variables: vars,
        attempt,
        ...(lastFailureSummary ? { previousFailure: lastFailureSummary } : {}),
        ...(context.memoryText ? { memoryText: context.memoryText } : {}),
        ...(context.knowledgeText ? { knowledgeText: context.knowledgeText } : {}),
        ...(context.guardrailsText ? { guardrailsText: context.guardrailsText } : {}),
      });
      const resolvedInstruction = renderInstruction(loop.condition, vars).text;
      const messages: LlmMessage[] = [...built.messages];
      const usage = { inputTokens: 0, outputTokens: 0 };
      let failureSummary = 'The model never decided the loop.';

      let decided: 'finished' | 'continue' | null = null;
      let decidedReason = '';
      for (let turn = 0; turn < 3 && !decided; turn += 1) {
        const completion = await llm.provider.complete({
          system: LOOP_SYSTEM_PROMPT,
          messages,
          tools: [LOOP_DECISION_DEF],
          toolChoice: { name: LOOP_DECISION_TOOL },
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
        const decisionUse = toolUses.find((use) => use.name === LOOP_DECISION_TOOL);
        const choice = decisionUse ? loopArgsOf(decisionUse.input) : null;
        if (decisionUse && choice) {
          decided = choice.choice;
          decidedReason = choice.reason;
          break;
        }
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Call loop_decision exactly once with {choice: "finished" | "continue", reason}.',
            },
          ],
        });
      }

      if (decided) {
        const detail = {
          resolvedInstruction: clip(resolvedInstruction, PREVIEW_CHARS),
          llmSummary: clip(decidedReason, PREVIEW_CHARS),
          declaredOutcome: 'success',
          loopDecision: decided,
          ...(built.unbound.length > 0 ? { unboundVariables: built.unbound } : {}),
          usage,
        };
        await db
          .updateTable('agent_run_steps')
          .set({
            status: 'succeeded',
            outcome: 'loop_decided',
            outcome_code: null,
            tool_call_count: 0,
            detail: clip(JSON.stringify(detail), DETAIL_CHARS),
            finished_at: sql`NOW()`,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', rowId)
          .execute();
        return { kind: 'decided', choice: decided };
      }

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
    context: RunContextText,
    blockedTools: ReadonlySet<string>,
    iteration: number,
    savesItemsForLoop: boolean
  ): Promise<AttemptOutcome> {
    const guidanceText = guidance ? renderInstruction(guidance, vars).text : undefined;
    const previousFailure =
      attempt > 1 ? await lastFailureText(run.id, step.id, iteration) : undefined;
    const toolCap = attempt > 1 ? CORRECTIVE_TOOL_CAP : NORMAL_TOOL_CAP;
    const built = buildAttemptMessages({
      step,
      attempt,
      variables: vars,
      toolBudget: toolCap,
      guidanceText,
      previousFailure,
      savesItemsForLoop,
      ...(context.memoryText ? { memoryText: context.memoryText } : {}),
      ...(context.knowledgeText ? { knowledgeText: context.knowledgeText } : {}),
      ...(context.guardrailsText ? { guardrailsText: context.guardrailsText } : {}),
    });

    // The step's one tool, plus (on corrective attempts) the guidance's
    // chips — the deliberately laxer set for fixing a failure. Blocked
    // skills never enter the offer, so guidance chips can't smuggle one
    // past the guardrails.
    // resolve_time rides alongside finish_step: in-process, deterministic,
    // free of the budget, and NOT the step's "one tool" — a step whose one
    // skill is a mail search must still be able to work out what
    // "yesterday 19:00 Los Angeles" means without spending its only call.
    const offered: LlmToolDef[] = [FINISH_STEP_DEF, RESOLVE_TIME_DEF];
    const primaryTool = step.tool;
    const offeredNames = new Set<string>([FINISH_STEP_TOOL, RESOLVE_TIME_TOOL]);
    const offer = (name: string) => {
      if (blockedTools.has(name)) return;
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
    // Attachment budget for the whole attempt: document/image blocks get
    // resent with every subsequent turn's messages, so they are priced as
    // scarce — over-budget attachments are dropped (their extracted text
    // already rode the tool result), never queued.
    const attachmentBudget = { blocks: 0, base64Chars: 0 };
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
        system: systemPromptWith(context.guardrailsText || undefined),
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
          if (toolCalls.every((call) => call.free)) throw new TransientFailure(`model ${kind}`);
          return {
            ...base,
            succeeded: false,
            outcome: 'llm_error',
            outcomeCode: 'service-unavailable',
            summary: `The model became unavailable mid-attempt (${kind}).`,
            saveValue: null,
            saveItems: null,
          };
        }
        return {
          ...base,
          succeeded: false,
          outcome: 'llm_error',
          outcomeCode: 'other',
          summary: completion.err.message ?? `The model failed (${kind}).`,
          saveValue: null,
          saveItems: null,
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
      const attachments: AttachmentBlock[] = [];
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

        // Free and local: answered here, never sent to MCP, never charged
        // against the budget. Placed ahead of the budget check on purpose
        // — a model that has spent its calls must still be able to get a
        // date right while declaring its outcome.
        if (use.name === RESOLVE_TIME_TOOL) {
          const resolved = resolveTime(resolveTimeArgsOf(use.input));
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: resolved.ok
              ? JSON.stringify(resolved.value)
              : `${resolved.error} Call ${RESOLVE_TIME_TOOL} again with that corrected — it is free.`,
            isError: !resolved.ok,
          });
          // Recorded for the run timeline (someone reading a bad search
          // wants to see which instant was computed), but not counted:
          // tool_call_count is the budget's tally.
          toolCalls.push({
            free: true,
            tool: RESOLVE_TIME_TOOL,
            argsPreview: clip(JSON.stringify(use.input ?? {}), PREVIEW_CHARS),
            resultPreview: clip(
              resolved.ok ? `${resolved.value.iso} (${resolved.value.local})` : resolved.error,
              PREVIEW_CHARS
            ),
            isError: !resolved.ok,
            durationMs: 0,
          });
          continue;
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
        const billedCalls = toolCalls.filter((call) => !call.free);
        if (billedCalls.length >= toolCap) {
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
            billedCalls.length > 1 && billedCalls.every((call) => call.tool === use.name);
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
        for (const block of attachmentBlocksOfMeta(result.meta)) {
          if (
            attachmentBudget.blocks >= ATTACHMENT_MAX_BLOCKS ||
            attachmentBudget.base64Chars + block.dataBase64.length > ATTACHMENT_MAX_BASE64_CHARS
          ) {
            logger.debug('attachment block dropped over budget for run {runId}', {
              component: 'worker-agents/engine',
              runId: run.id,
              tool: use.name,
              mediaType: block.mediaType,
            });
            continue;
          }
          attachmentBudget.blocks += 1;
          attachmentBudget.base64Chars += block.dataBase64.length;
          attachments.push(block);
        }
      }
      // tool_result blocks first (the wire contract), then any documents the
      // tools attached for the model to see.
      messages.push({ role: 'user', content: [...results, ...attachments] });
    }

    return {
      ...base,
      succeeded: false,
      outcome: 'llm_error',
      outcomeCode: 'other',
      summary: 'The model never declared an outcome for this step.',
      saveValue: null,
      saveItems: null,
    };
  }

  function decideOutcome(
    step: ActionStep,
    finish: {
      outcome: 'success' | 'failure' | 'nothing-to-do';
      code: string | null;
      summary: string;
      saveValue: string | null;
      saveItems: string[] | null;
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
        saveItems: null,
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
          saveItems: null,
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
        saveItems: finish.saveItems,
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
      saveItems: null,
      // A declared failure may still be worth remembering ("ticket X is
      // locked, skip it") — the model asked, keep it.
      remember: finish.remember,
    };
  }

  async function lastFailureText(
    runId: string,
    stepId: string,
    iteration: number
  ): Promise<string | undefined> {
    const row = await db
      .selectFrom('agent_run_steps')
      .select('detail')
      .where('run_id', '=', runId)
      .where('step_id', '=', stepId)
      .where('iteration', '=', iteration)
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
