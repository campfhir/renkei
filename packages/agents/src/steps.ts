/**
 * The shape of a drafted agent: what the builder edits, the `agents.steps`
 * column stores, and the runtime executes from a run's snapshot.
 *
 * Instructions are SEGMENT ARRAYS, not template strings. A chip the user
 * inserted is a `{ t: 'tool' | 'var' }` segment sitting between text
 * segments — there is no inline `{{token}}` syntax to parse, so a user who
 * literally types braces breaks nothing, validation is an array walk, and
 * rendering to prompt text is an explicit act (render.ts) rather than an
 * interpolation that could be tricked.
 *
 * The one-tool rule: a step names AT MOST one tool (`tool: string | null`);
 * a null-tool step is pure reasoning/formatting and has no failure panel.
 * Failure handling is keyed by outcome CODE — the enumeration served with
 * the tool catalog (apps/web lib/mcp-tools/outcomes.ts) — with `other` as
 * the always-present catch-all. A code with no handling entry means exit.
 *
 * `maxAttempts` is the user's TOTAL attempt budget for the step. The
 * ceiling is enforced twice: the validator clamps what gets persisted, and
 * the engine re-counts attempt rows in the database before starting
 * another — the snapshot is never the authority.
 *
 * BRANCHING (version 2): a node may instead be a `BranchStep` — an
 * LLM-evaluated yes/no condition with two named paths, each a nested list
 * of nodes. Structured blocks, not a goto graph: when a path finishes,
 * execution continues after the branch. `version` is 2 IF AND ONLY IF the
 * document contains a branch (normalizeAgentDraft recomputes it), so a
 * linear agent saved by new code stays byte-identical version 1 and old
 * workers refuse only what they genuinely cannot run.
 *
 * VERSION 3 adds three constructs, still structured blocks:
 *   - `LoopStep` — a body repeated per item of a saved list (`foreach`) or
 *     until an LLM-evaluated condition holds (`until`), always bounded by
 *     `maxIterations`. Loops never nest. Optional `collectFrom`/`collectVar`
 *     turn the loop into a map/filter: whatever the named body step saved
 *     each iteration (nothing, one value, or a saveItems list — the output
 *     set may be smaller or larger than the input) is appended to a new
 *     list variable a later step or loop can consume.
 *   - `GroupStep` — pure structure for readability: executes exactly as if
 *     its steps were inlined; no attempt row, no LLM call, no depth cost.
 *   - N-way branches — `paths` grows from a fixed pair to 2..5 labeled
 *     routes (the LAST is the fallback by convention), plus at most one
 *     optional `failurePath`: the structural exit taken when the branch
 *     EVALUATION itself exhausts its attempts, never a choice offered to
 *     the model. An empty failurePath swallows the failure and continues.
 *   Inside a loop body, `onSuccess: 'stop'`/`'stop-quiet'` and a
 *   `stop-quiet` failure handling end the WHOLE run, not the iteration.
 *   `saveAs` written inside a body is last-write-wins across iterations;
 *   per-iteration values remain visible in run history.
 *
 * VERSION 4 adds one construct:
 *   - `TerminalStep` — an explicit end marker. Reaching it ends the WHOLE
 *     run (inside a branch path or loop body too) with a configured result
 *     — success, failure, or a graceful "nothing to do" — and delivers the
 *     node's own notification (email and/or WebEx, message rendered with
 *     the run's variables). It is the opt-in replacement for the implicit
 *     context-free failure mail: the endpoint says what to send and where.
 *     A leaf: no children, no LLM call, deterministic.
 *
 * VERSION 5 adds one construct:
 *   - `ApprovalStep` — a human-in-the-loop pause. Reaching it parks the
 *     whole run as 'waiting', puts an interactive card on the owner's
 *     home-page feed (approve/reject, or a typed answer in 'input' mode),
 *     optionally notifies them with the card link, and resumes down ONE
 *     of three outcome paths — approved/answered, declined, or timed out
 *     (every wait has a ceiling, org-bounded). Branch-like on purpose:
 *     the outcome paths are nested step lists, an empty path falls
 *     through, and the node counts toward the same nesting budgets as a
 *     branch.
 *
 * `requiredVersion` is the single version rule: 5 iff an approval node is
 * present, else 4 iff a terminal node is, else 3 iff any v3 construct is,
 * else 2 iff a branch exists, else 1 — so every document any older writer
 * could produce keeps its exact old version and bytes.
 */

/**
 * A DATE CHIP: a timestamp computed at render time, before the model reads
 * the instruction.
 *
 * The model is not asked to work the date out and not asked to call
 * anything for it — by the time the prompt exists, "yesterday at 19:00 Los
 * Angeles" is already the literal instant. That is the difference between a
 * date being deterministic and a date being usually right.
 *
 * The parameters are the same vocabulary resolveTime speaks: a signed
 * amount and a unit, an optional time of day, an optional snap to the start
 * or end of the unit.
 */
export interface DateSegment {
  t: 'date';
  /** Signed: -1 with unit 'day' is yesterday, 0 is today. */
  amount: number;
  unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
  /**
   * IANA zone, e.g. 'America/Los_Angeles'. Deliberately not a fixed offset
   * like '-08:00': an offset is wrong for half the year in any zone that
   * observes daylight saving, which is exactly the error this chip exists
   * to remove.
   */
  timezone: string;
  /** 'HH:MM' wall-clock time in `timezone`, applied after the shift. */
  atTime?: string;
  /** Snap to the start or end of `unit`; ignored when atTime is set. */
  boundary?: 'start' | 'end';
  /**
   * How it reads in the prompt. 'iso' (default) is the instant a tool
   * wants; 'date' is YYYY-MM-DD for query languages that take a day;
   * 'datetime' is the local reading, for text a person will see.
   */
  format?: 'iso' | 'date' | 'datetime';
}

export type InstructionSegment =
  { t: 'text'; v: string } | { t: 'tool'; name: string } | { t: 'var'; name: string } | DateSegment;

export interface FailureHandling {
  /** Failure code from the tool's outcome enumeration, incl. 'other'. */
  outcome: string;
  /**
   * 'exit' fails the run (the default for unhandled codes); 'retry' tries
   * again with guidance; 'stop-quiet' declares the outcome NOT an error —
   * "ticket not found" is sometimes just "nothing to do" — and ends the run
   * gracefully as 'stopped': silent like onSuccess 'stop-quiet' (no reply,
   * no notification, no chained agents), recorded in run history only.
   */
  action: 'retry' | 'exit' | 'stop-quiet';
  /**
   * Corrective guidance shown to the model on retry attempts. Required for
   * 'retry'. MAY contain tool chips — several, deliberately laxer than the
   * step body — which become the extra tools offered while correcting.
   */
  guidance?: InstructionSegment[];
}

export interface ActionStep {
  /** uuid, stable across reorders; run records reference it. */
  id: string;
  /**
   * Optional discriminant, ABSENT on the wire (the normalizer strips it):
   * v1 documents predate the field, and keeping linear docs byte-identical
   * across old and new writers is what makes the version rule safe.
   */
  kind?: 'action';
  name: string;
  instruction: InstructionSegment[];
  /** At most one tool; null = reasoning/formatting step. */
  tool: string | null;
  /** Total attempts for this step, 1..the org's cap. */
  maxAttempts: number;
  /** Names this step's result; later steps reference it as a var chip. */
  saveAs?: string;
  failureHandling: FailureHandling[];
  /**
   * What success leads to. Absent/'continue' = the next step (the default
   * linear flow); 'stop' = the whole automation finishes successfully here
   * (thread reply / chaining still happen); 'stop-quiet' = it finishes
   * silently — no reply, no notification, no chained agents, history only.
   * Conditional early stops stay in the instruction's own words — the
   * runner honors "…and stop here" (and "stop silently") at runtime; this
   * switch is the STATIC version, explicit in the UI instead of implied by
   * prose.
   */
  onSuccess?: 'continue' | 'stop' | 'stop-quiet';
}

/**
 * @deprecated Alias for {@link ActionStep} — kept so existing imports keep
 * compiling while call sites migrate to the node vocabulary.
 */
export type AgentStep = ActionStep;

export interface BranchPath {
  /** uuid — its own id space, but uniqueness is enforced doc-wide. */
  id: string;
  /** User-facing label, e.g. "A ticket exists" / "Otherwise". */
  name: string;
  /** MAY be empty: an empty else-path just falls through. */
  steps: AgentStepNode[];
}

export interface BranchStep {
  /** uuid, same id space as steps; run records reference it. */
  id: string;
  /** The required discriminant — action steps never carry 'branch'. */
  kind: 'branch';
  name: string;
  /**
   * The LLM-evaluated condition. Prose plus var chips; tool chips are
   * rejected by the validator — the evaluator offers no tools. With two
   * paths it reads as yes/no; with more it asks "which of these applies?"
   */
  condition: InstructionSegment[];
  /**
   * 2..MAX_BRANCH_PATHS, ordered. Two-path branches keep the v2 reading
   * (paths[0] = condition holds, paths[1] = else). For more, the LAST path
   * is the fallback by convention — the evaluator is told to pick it when
   * nothing clearly applies; no schema flag exists because the engine
   * forces exactly one choice either way.
   */
  paths: BranchPath[];
  /**
   * The structural exit (version 3): taken when the branch EVALUATION
   * exhausts its attempts — model errors, not a decision. Never offered as
   * a choice. Empty steps = swallow the failure and continue after the
   * branch. Absent = evaluation failure fails the run (the v2 behavior).
   */
  failurePath?: BranchPath;
  /** Attempt budget for the condition evaluation itself. */
  maxAttempts: number;
}

export interface ForEachLoopStep {
  /** uuid, same doc-wide id space as every node. */
  id: string;
  kind: 'loop';
  mode: 'foreach';
  name: string;
  /** The list to iterate: a saveAs/collectVar name or list-valued trigger input. */
  itemsVar: string;
  /** The per-iteration binding the body references as a var chip. */
  itemVar: string;
  /** Iteration ceiling, 1..MAX_LOOP_ITERATIONS; extra items are skipped with a note. */
  maxIterations: number;
  /** Appended per iteration when set — see collectVar. */
  collectFrom?: string;
  /**
   * The list variable this loop builds: each iteration appends whatever
   * the body step named by `collectFrom` actually saved (nothing, one
   * value, or its saveItems list) — the output set may be smaller or
   * larger than the input.
   */
  collectVar?: string;
  /** Child key is `steps`, keeping the issue-path grammar uniform. */
  steps: AgentStepNode[];
}

export interface UntilLoopStep {
  id: string;
  kind: 'loop';
  mode: 'until';
  name: string;
  /**
   * The LLM-evaluated stop condition — same grammar and rules as a branch
   * condition (prose + var chips, no tools). Evaluated AFTER each
   * iteration: the body always runs at least once.
   */
  condition: InstructionSegment[];
  /** Attempt budget per condition evaluation, like BranchStep.maxAttempts. */
  maxAttempts: number;
  /**
   * REQUIRED, 1..MAX_LOOP_ITERATIONS. Reaching it with the condition still
   * unmet FAILS the run — the guard is a tripwire for a premise that never
   * came true, not a quiet exit.
   */
  maxIterations: number;
  collectFrom?: string;
  collectVar?: string;
  steps: AgentStepNode[];
}

export type LoopStep = ForEachLoopStep | UntilLoopStep;

export interface GroupStep {
  id: string;
  kind: 'group';
  name: string;
  /**
   * Pure grouping: executes exactly as if inlined — no attempt row, no LLM
   * call, and no nesting-depth cost. Exists so a busy flow can fold.
   */
  steps: AgentStepNode[];
}

/**
 * How a terminal node ends the run: 'success' finishes it as intended
 * (chained agents still fire); 'failure' is the DELIBERATE failure — the
 * run records as failed with the node's rendered message as the error;
 * 'stop' is the graceful "nothing to do" ending (run status 'stopped').
 */
export type TerminalResult = 'success' | 'failure' | 'stop';

export interface TerminalStep {
  /** uuid, same doc-wide id space as every node. */
  id: string;
  kind: 'terminal';
  name: string;
  result: TerminalResult;
  /**
   * The notification body — prose + var chips (never tool chips), rendered
   * with the run's live variables so what lands in the inbox carries real
   * context. May be empty when no channel is on.
   */
  message: InstructionSegment[];
  /** Email the rendered message to the owner (sent from their own grant). */
  notifyEmail: boolean;
  /** Post the rendered message to the owner's WebEx note-to-self space. */
  notifyWebex: boolean;
}

export type ApprovalMode = 'approve' | 'input';

export interface ApprovalStep {
  /** uuid, same doc-wide id space as every node. */
  id: string;
  kind: 'approval';
  name: string;
  /**
   * What the owner is being asked — prose + var chips (never tool chips),
   * rendered with the run's live values. The card body AND the
   * notification body.
   */
  message: InstructionSegment[];
  /** 'approve' = approve/decline buttons; 'input' = a typed answer. */
  mode: ApprovalMode;
  /**
   * REQUIRED in 'input' mode: the owner's answer binds to this name for
   * the outcome paths and everything after the node. Same namespace as
   * saveAs/loop bindings.
   */
  saveAs?: string;
  /**
   * How long the run may wait, in hours — clamped by the org's
   * agentApprovalMaxWaitDays cap at save AND live at pause time. Reaching
   * it routes onTimeout; it never fails the run by itself.
   */
  timeoutHours: number;
  /** Send the message + card link to the owner's own inbox at pause. */
  notifyEmail: boolean;
  /** Post the message + card link to the owner's WebEx note-to-self. */
  notifyWebex: boolean;
  /** Approved (or, in input mode, answered). Empty = continue after. */
  onApproved: BranchPath;
  /** Declined — the Reject / "Stop the run" button. Empty = continue. */
  onDeclined: BranchPath;
  /** Nobody acted before the ceiling. Empty = continue after the node. */
  onTimeout: BranchPath;
}

export type AgentStepNode =
  ActionStep | BranchStep | LoopStep | GroupStep | TerminalStep | ApprovalStep;

export interface AgentStepsDoc {
  /** See requiredVersion: 5 approval, 4 terminal, 3 v3 constructs, 2 plain branches, else 1. */
  version: 1 | 2 | 3 | 4 | 5 | 6;
  /** Array order is execution order; success is linear within a list. */
  steps: AgentStepNode[];
}

/**
 * The DEFAULT ceiling on a step's total attempts. The real ceiling is the
 * org's `agentMaxStepAttempts` setting, which may exceed this; this value
 * binds only where no settings are in hand.
 */
export const MAX_STEP_ATTEMPTS = 10;
export const MAX_STEPS = 20;
export const MAX_INSTRUCTION_CHARS = 4_000;
/**
 * The FROZEN v2 limit — a branch inside a branch, nothing deeper. Only the
 * v2 structural arm still reads this; new documents live under the v3
 * limits below.
 */
export const MAX_BRANCH_DEPTH = 2;
/** Version 3: conditionals may nest three deep. */
export const MAX_BRANCH_DEPTH_V3 = 3;
/**
 * Version 3's combined containment ceiling: branch and loop levels count,
 * groups do not — a loop wrapped around three nested branches is legal and
 * is the deepest legal shape.
 */
export const MAX_CONTAINER_DEPTH = 4;
/** Version 3: a branch routes between 2 and this many labeled paths. */
export const MAX_BRANCH_PATHS = 5;
/** Iteration ceiling every loop must declare within. */
export const MAX_LOOP_ITERATIONS = 25;
/** Ceiling on entries a loop's collectVar may accumulate. */
export const MAX_COLLECTED_ITEMS = 100;
/** Default attempt budget for a branch's condition evaluation. */
export const BRANCH_DEFAULT_ATTEMPTS = 2;
/** Default attempt budget for an until-loop's condition evaluation. */
export const LOOP_DEFAULT_ATTEMPTS = 2;
/** Default iteration ceiling the editors seed. */
export const LOOP_DEFAULT_ITERATIONS = 10;
/**
 * Sanity bound on the guardrails document, NOT a style rule: guardrails
 * are injected into every model call IN FULL (a clipped "no PHI" rule is
 * worse than none), so their length is the owner's informed cost choice.
 * This cap exists only so a paste accident or abuse cannot park a
 * megabyte-scale blob in every prompt.
 */
export const MAX_GUARDRAILS_CHARS = 1_000_000;
/** Default wait ceiling the approval editor seeds: three days. */
export const APPROVAL_DEFAULT_TIMEOUT_HOURS = 72;
/**
 * The approval wait cap used when no org settings are in hand — matches
 * the org setting's default (agentApprovalMaxWaitDays = 14). The live
 * setting binds at save (normalizeAgentDraft option) and again at pause.
 */
export const DEFAULT_APPROVAL_WAIT_CAP_HOURS = 14 * 24;

/**
 * `saveAs` names and API-trigger input names share this shape. Spaces are
 * allowed mid-name ("the ticket", "Find the ticket result") — these are
 * labels people read, not identifiers — but not at either end, which the
 * normalizer's trim guarantees before validation sees them.
 */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/;

const DATE_UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'];

/**
 * Structural check for a date chip. Kept in the SHARED segment guard rather
 * than a frozen v6 copy: a document containing one is labeled version 6 by
 * requiredVersion, and a worker that predates date chips rejects an unknown
 * version outright — which is the guarantee that actually protects an old
 * reader from a construct it cannot render.
 */
function isDateSegment(value: unknown): value is DateSegment {
  const segment: {
    amount?: unknown;
    unit?: unknown;
    timezone?: unknown;
    atTime?: unknown;
    boundary?: unknown;
    format?: unknown;
  } = typeof value === 'object' && value !== null ? value : {};
  if (typeof segment.amount !== 'number' || !Number.isFinite(segment.amount)) return false;
  if (typeof segment.unit !== 'string' || !DATE_UNITS.includes(segment.unit)) return false;
  if (typeof segment.timezone !== 'string' || segment.timezone.length === 0) return false;
  if (segment.atTime !== undefined && typeof segment.atTime !== 'string') return false;
  if (
    segment.boundary !== undefined &&
    segment.boundary !== 'start' &&
    segment.boundary !== 'end'
  ) {
    return false;
  }
  if (
    segment.format !== undefined &&
    segment.format !== 'iso' &&
    segment.format !== 'date' &&
    segment.format !== 'datetime'
  ) {
    return false;
  }
  return true;
}

export function isInstructionSegment(value: unknown): value is InstructionSegment {
  if (typeof value !== 'object' || value === null) return false;
  const segment: { t?: unknown; v?: unknown; name?: unknown } = value;
  if (segment.t === 'text') return typeof segment.v === 'string';
  if (segment.t === 'tool' || segment.t === 'var') {
    return typeof segment.name === 'string' && segment.name.length > 0;
  }
  if (segment.t === 'date') return isDateSegment(value);
  return false;
}

function isFailureHandling(value: unknown): value is FailureHandling {
  if (typeof value !== 'object' || value === null) return false;
  const entry: { outcome?: unknown; action?: unknown; guidance?: unknown } = value;
  if (typeof entry.outcome !== 'string' || entry.outcome.length === 0) return false;
  if (entry.action !== 'retry' && entry.action !== 'exit' && entry.action !== 'stop-quiet') {
    return false;
  }
  if (entry.guidance !== undefined) {
    if (!Array.isArray(entry.guidance)) return false;
    if (!entry.guidance.every(isInstructionSegment)) return false;
  }
  return true;
}

function isActionStep(value: unknown): value is ActionStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    instruction?: unknown;
    tool?: unknown;
    maxAttempts?: unknown;
    saveAs?: unknown;
    failureHandling?: unknown;
    onSuccess?: unknown;
  } = value;
  if (step.kind !== undefined && step.kind !== 'action') return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (!Array.isArray(step.instruction) || !step.instruction.every(isInstructionSegment)) {
    return false;
  }
  if (step.tool !== null && typeof step.tool !== 'string') return false;
  if (typeof step.maxAttempts !== 'number') return false;
  if (step.saveAs !== undefined && typeof step.saveAs !== 'string') return false;
  if (!Array.isArray(step.failureHandling) || !step.failureHandling.every(isFailureHandling)) {
    return false;
  }
  if (
    step.onSuccess !== undefined &&
    step.onSuccess !== 'continue' &&
    step.onSuccess !== 'stop' &&
    step.onSuccess !== 'stop-quiet'
  ) {
    return false;
  }
  return true;
}

export function isBranchStep(node: AgentStepNode): node is BranchStep {
  return node.kind === 'branch';
}

export function isLoopStep(node: AgentStepNode): node is LoopStep {
  return node.kind === 'loop';
}

export function isGroupStep(node: AgentStepNode): node is GroupStep {
  return node.kind === 'group';
}

export function isTerminalStep(node: AgentStepNode): node is TerminalStep {
  return node.kind === 'terminal';
}

export function isApprovalStep(node: AgentStepNode): node is ApprovalStep {
  return node.kind === 'approval';
}

/** A node whose `steps`/`paths` contain other nodes. */
export function isContainerNode(node: AgentStepNode): node is BranchStep | LoopStep | GroupStep {
  return node.kind === 'branch' || node.kind === 'loop' || node.kind === 'group';
}

/**
 * The node's kind with the action default made explicit. Dispatch on THIS
 * (or on `node.kind` directly) with an exhaustive switch and a `never`
 * default, not on binary `isBranchStep` ternaries: a ternary silently
 * treats every future kind as an ActionStep, which is exactly how a new
 * construct would misexecute.
 */
export type NodeKind = 'action' | 'branch' | 'loop' | 'group' | 'terminal' | 'approval';

export function nodeKind(node: AgentStepNode): NodeKind {
  return node.kind ?? 'action';
}

/** The three outcome slots of an approval node, in display order. */
export const APPROVAL_OUTCOME_KEYS = ['onApproved', 'onDeclined', 'onTimeout'] as const;
export type ApprovalOutcomeKey = (typeof APPROVAL_OUTCOME_KEYS)[number];

/** An approval node's outcome paths as key/path pairs — the shared walk vocabulary. */
export function approvalPathsOf(
  node: ApprovalStep
): { key: ApprovalOutcomeKey; path: BranchPath }[] {
  return APPROVAL_OUTCOME_KEYS.map((key) => ({ key, path: node[key] }));
}

/* ---------------- FROZEN v2 structural arm ------------------------- */
/* Byte-for-byte the pre-v3 checks: two-path branches, depth ≤ 2, no    */
/* loops or groups. v2 snapshots must parse forever exactly as they did. */

function isBranchPathV2(value: unknown, depth: number): value is BranchPath {
  if (typeof value !== 'object' || value === null) return false;
  const path: { id?: unknown; name?: unknown; steps?: unknown } = value;
  if (typeof path.id !== 'string' || path.id.length === 0) return false;
  if (typeof path.name !== 'string') return false;
  return Array.isArray(path.steps) && path.steps.every((step) => isNodeV2(step, depth));
}

function isBranchStepShapeV2(value: unknown, depth: number): value is BranchStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    condition?: unknown;
    paths?: unknown;
    failurePath?: unknown;
    maxAttempts?: unknown;
  } = value;
  if (step.kind !== 'branch') return false;
  // Defensive vs pathological jsonb: reject nesting the v2 engine won't run.
  if (depth > MAX_BRANCH_DEPTH) return false;
  if (step.failurePath !== undefined) return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (!Array.isArray(step.condition) || !step.condition.every(isInstructionSegment)) return false;
  if (typeof step.maxAttempts !== 'number') return false;
  return (
    Array.isArray(step.paths) &&
    step.paths.length === 2 &&
    step.paths.every((path) => isBranchPathV2(path, depth + 1))
  );
}

function isNodeV2(value: unknown, depth: number): value is AgentStepNode {
  if (typeof value === 'object' && value !== null) {
    const candidate: { kind?: unknown } = value;
    if (candidate.kind === 'branch') return isBranchStepShapeV2(value, depth);
    if (candidate.kind === 'loop' || candidate.kind === 'group') return false;
  }
  return isActionStep(value);
}

/* ---------------- v3/v4 structural arm ------------------------------ */
/* The container checks are shared between the two arms via the `isNode` */
/* recursion parameter: v3 recurses with isNodeV3 (terminal nodes are    */
/* NOT admitted — a doc labeled below the version its constructs demand  */
/* is invalid), v4 with isNodeV4 (terminal leaves allowed anywhere).     */

/** Containment counters the v3+ shape checks thread through the tree. */
interface GuardContext {
  /** Nested branch levels entered so far. */
  branchDepth: number;
  /** Branch + loop levels entered so far (groups are free). */
  containerDepth: number;
  /** Loops never nest. */
  inLoop: boolean;
}

type NodeShapeCheck = (value: unknown, context: GuardContext) => value is AgentStepNode;

function isBranchPathV3(
  value: unknown,
  context: GuardContext,
  isNode: NodeShapeCheck
): value is BranchPath {
  if (typeof value !== 'object' || value === null) return false;
  const path: { id?: unknown; name?: unknown; steps?: unknown } = value;
  if (typeof path.id !== 'string' || path.id.length === 0) return false;
  if (typeof path.name !== 'string') return false;
  return Array.isArray(path.steps) && path.steps.every((step) => isNode(step, context));
}

function isBranchStepShapeV3(
  value: unknown,
  context: GuardContext,
  isNode: NodeShapeCheck
): value is BranchStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    condition?: unknown;
    paths?: unknown;
    failurePath?: unknown;
    maxAttempts?: unknown;
  } = value;
  if (step.kind !== 'branch') return false;
  const inner: GuardContext = {
    branchDepth: context.branchDepth + 1,
    containerDepth: context.containerDepth + 1,
    inLoop: context.inLoop,
  };
  if (inner.branchDepth > MAX_BRANCH_DEPTH_V3) return false;
  if (inner.containerDepth > MAX_CONTAINER_DEPTH) return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (!Array.isArray(step.condition) || !step.condition.every(isInstructionSegment)) return false;
  if (typeof step.maxAttempts !== 'number') return false;
  if (step.failurePath !== undefined && !isBranchPathV3(step.failurePath, inner, isNode)) {
    return false;
  }
  return (
    Array.isArray(step.paths) &&
    step.paths.length >= 2 &&
    step.paths.length <= MAX_BRANCH_PATHS &&
    step.paths.every((path) => isBranchPathV3(path, inner, isNode))
  );
}

function isLoopStepShape(
  value: unknown,
  context: GuardContext,
  isNode: NodeShapeCheck
): value is LoopStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    kind?: unknown;
    mode?: unknown;
    name?: unknown;
    itemsVar?: unknown;
    itemVar?: unknown;
    condition?: unknown;
    maxAttempts?: unknown;
    maxIterations?: unknown;
    collectFrom?: unknown;
    collectVar?: unknown;
    steps?: unknown;
  } = value;
  if (step.kind !== 'loop') return false;
  if (context.inLoop) return false;
  const inner: GuardContext = {
    branchDepth: context.branchDepth,
    containerDepth: context.containerDepth + 1,
    inLoop: true,
  };
  if (inner.containerDepth > MAX_CONTAINER_DEPTH) return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (typeof step.maxIterations !== 'number') return false;
  if (step.collectFrom !== undefined && typeof step.collectFrom !== 'string') return false;
  if (step.collectVar !== undefined && typeof step.collectVar !== 'string') return false;
  if (step.mode === 'foreach') {
    if (typeof step.itemsVar !== 'string' || step.itemsVar.length === 0) return false;
    if (typeof step.itemVar !== 'string' || step.itemVar.length === 0) return false;
  } else if (step.mode === 'until') {
    if (!Array.isArray(step.condition) || !step.condition.every(isInstructionSegment)) {
      return false;
    }
    if (typeof step.maxAttempts !== 'number') return false;
  } else {
    return false;
  }
  return Array.isArray(step.steps) && step.steps.every((child) => isNode(child, inner));
}

function isGroupStepShape(
  value: unknown,
  context: GuardContext,
  isNode: NodeShapeCheck
): value is GroupStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: { id?: unknown; kind?: unknown; name?: unknown; steps?: unknown } = value;
  if (step.kind !== 'group') return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  // Depth-neutral on purpose: groups exist to organize, not to nest logic.
  return Array.isArray(step.steps) && step.steps.every((child) => isNode(child, context));
}

function isTerminalStepShape(value: unknown): value is TerminalStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    result?: unknown;
    message?: unknown;
    notifyEmail?: unknown;
    notifyWebex?: unknown;
  } = value;
  if (step.kind !== 'terminal') return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (step.result !== 'success' && step.result !== 'failure' && step.result !== 'stop') {
    return false;
  }
  if (!Array.isArray(step.message) || !step.message.every(isInstructionSegment)) return false;
  return typeof step.notifyEmail === 'boolean' && typeof step.notifyWebex === 'boolean';
}

function isNodeV3(value: unknown, context: GuardContext): value is AgentStepNode {
  if (typeof value === 'object' && value !== null) {
    const candidate: { kind?: unknown } = value;
    if (candidate.kind === 'branch') return isBranchStepShapeV3(value, context, isNodeV3);
    if (candidate.kind === 'loop') return isLoopStepShape(value, context, isNodeV3);
    if (candidate.kind === 'group') return isGroupStepShape(value, context, isNodeV3);
    // A v3-labeled document may not carry v4 constructs.
    if (candidate.kind === 'terminal') return false;
  }
  return isActionStep(value);
}

/* ---------------- v4 structural arm -------------------------------- */

function isNodeV4(value: unknown, context: GuardContext): value is AgentStepNode {
  if (typeof value === 'object' && value !== null) {
    const candidate: { kind?: unknown } = value;
    if (candidate.kind === 'branch') return isBranchStepShapeV3(value, context, isNodeV4);
    if (candidate.kind === 'loop') return isLoopStepShape(value, context, isNodeV4);
    if (candidate.kind === 'group') return isGroupStepShape(value, context, isNodeV4);
    if (candidate.kind === 'terminal') return isTerminalStepShape(value);
    // A v4-labeled document may not carry v5 constructs.
    if (candidate.kind === 'approval') return false;
  }
  return isActionStep(value);
}

/* ---------------- v5 structural arm -------------------------------- */

function isApprovalStepShape(
  value: unknown,
  context: GuardContext,
  isNode: NodeShapeCheck
): value is ApprovalStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    message?: unknown;
    mode?: unknown;
    saveAs?: unknown;
    timeoutHours?: unknown;
    notifyEmail?: unknown;
    notifyWebex?: unknown;
    onApproved?: unknown;
    onDeclined?: unknown;
    onTimeout?: unknown;
  } = value;
  if (step.kind !== 'approval') return false;
  // Branch-like containment: the pause consumes a branch level and a
  // container level, same budgets as a BranchStep.
  const inner: GuardContext = {
    branchDepth: context.branchDepth + 1,
    containerDepth: context.containerDepth + 1,
    inLoop: context.inLoop,
  };
  if (inner.branchDepth > MAX_BRANCH_DEPTH_V3) return false;
  if (inner.containerDepth > MAX_CONTAINER_DEPTH) return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (!Array.isArray(step.message) || !step.message.every(isInstructionSegment)) return false;
  if (step.mode !== 'approve' && step.mode !== 'input') return false;
  if (step.saveAs !== undefined && typeof step.saveAs !== 'string') return false;
  if (typeof step.timeoutHours !== 'number') return false;
  if (typeof step.notifyEmail !== 'boolean' || typeof step.notifyWebex !== 'boolean') return false;
  return (
    isBranchPathV3(step.onApproved, inner, isNode) &&
    isBranchPathV3(step.onDeclined, inner, isNode) &&
    isBranchPathV3(step.onTimeout, inner, isNode)
  );
}

function isNodeV5(value: unknown, context: GuardContext): value is AgentStepNode {
  if (typeof value === 'object' && value !== null) {
    const candidate: { kind?: unknown } = value;
    if (candidate.kind === 'branch') return isBranchStepShapeV3(value, context, isNodeV5);
    if (candidate.kind === 'loop') return isLoopStepShape(value, context, isNodeV5);
    if (candidate.kind === 'group') return isGroupStepShape(value, context, isNodeV5);
    if (candidate.kind === 'terminal') return isTerminalStepShape(value);
    if (candidate.kind === 'approval') return isApprovalStepShape(value, context, isNodeV5);
  }
  return isActionStep(value);
}

/**
 * Whether a stored `steps` jsonb value is a document this build executes.
 * Structural only — business rules (attempt clamp, tool existence, variable
 * binding) are the validator's job on the way IN; this guards the way OUT,
 * where the value has already been through it.
 *
 * The version-1 arm is exactly the pre-branch check and the version-2 arm
 * exactly the pre-v3 check: old snapshots parse unchanged forever, and a
 * doc labeled below the version its constructs demand is NOT valid.
 */
export function isAgentStepsDoc(value: unknown): value is AgentStepsDoc {
  if (typeof value !== 'object' || value === null) return false;
  const doc: { version?: unknown; steps?: unknown } = value;
  if (doc.version === 1) {
    return Array.isArray(doc.steps) && doc.steps.every(isActionStep);
  }
  if (doc.version === 2) {
    return Array.isArray(doc.steps) && doc.steps.every((step) => isNodeV2(step, 1));
  }
  if (doc.version === 3) {
    const root: GuardContext = { branchDepth: 0, containerDepth: 0, inLoop: false };
    return Array.isArray(doc.steps) && doc.steps.every((step) => isNodeV3(step, root));
  }
  if (doc.version === 4) {
    const root: GuardContext = { branchDepth: 0, containerDepth: 0, inLoop: false };
    return Array.isArray(doc.steps) && doc.steps.every((step) => isNodeV4(step, root));
  }
  if (doc.version === 5 || doc.version === 6) {
    // Version 6 differs only in what an INSTRUCTION may contain (a date
    // chip), which the shared segment guard already covers — the node
    // shapes are v5's.
    const root: GuardContext = { branchDepth: 0, containerDepth: 0, inLoop: false };
    return Array.isArray(doc.steps) && doc.steps.every((step) => isNodeV5(step, root));
  }
  return false;
}

/** The tool chips in a segment list, in order of appearance. */
export function toolSegments(segments: InstructionSegment[]): string[] {
  return segments.flatMap((segment) => (segment.t === 'tool' ? [segment.name] : []));
}

/** The var chips in a segment list, in order of appearance. */
export function varSegments(segments: InstructionSegment[]): string[] {
  return segments.flatMap((segment) => (segment.t === 'var' ? [segment.name] : []));
}

/* ------------------------------------------------------------------ */
/* Tree walkers — the vocabulary every consumer of a v2 doc shares.    */
/* ------------------------------------------------------------------ */

export interface WalkedNode {
  node: AgentStepNode;
  /**
   * Validation path prefix of this node, e.g. `steps.2` or
   * `steps.2.paths.1.steps.0` — the same all-numeric grammar the validator
   * emits, so prefix matching works at every nesting level.
   */
  path: string;
  /** 1 for top level; +1 inside each branch path. */
  depth: number;
  /**
   * Pre-order position across the whole tree (branch nodes count). For a
   * v1 doc this equals the flat index — which is what keeps
   * `agent_run_steps.step_index` monotone and back-compatible.
   */
  ordinal: number;
}

/** Depth-first pre-order over every node, containers included. */
export function walkSteps(nodes: AgentStepNode[]): WalkedNode[] {
  const out: WalkedNode[] = [];
  let ordinal = 0;
  const visit = (list: AgentStepNode[], prefix: string, depth: number) => {
    list.forEach((node, index) => {
      const path = `${prefix}.${index}`;
      out.push({ node, path, depth, ordinal });
      ordinal += 1;
      switch (node.kind) {
        case 'branch':
          node.paths.forEach((branchPath, pathIndex) => {
            visit(branchPath.steps, `${path}.paths.${pathIndex}.steps`, depth + 1);
          });
          if (node.failurePath) {
            visit(node.failurePath.steps, `${path}.failurePath.steps`, depth + 1);
          }
          break;
        case 'loop':
        case 'group':
          visit(node.steps, `${path}.steps`, depth + 1);
          break;
        case 'approval':
          for (const { key, path: outcomePath } of approvalPathsOf(node)) {
            visit(outcomePath.steps, `${path}.${key}.steps`, depth + 1);
          }
          break;
        case 'terminal':
        case 'action':
        case undefined:
          break;
        default: {
          const unhandled: never = node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    });
  };
  visit(nodes, 'steps', 1);
  return out;
}

/** Every action step in pre-order — for saved-var recovery and previews. */
export function flattenActionSteps(nodes: AgentStepNode[]): ActionStep[] {
  return walkSteps(nodes).flatMap(({ node }) =>
    node.kind === undefined || node.kind === 'action' ? [node] : []
  );
}

/** Total node count — container nodes count 1 (their evaluation/structure costs a step). */
export function countNodes(nodes: AgentStepNode[]): number {
  return walkSteps(nodes).length;
}

/**
 * Whether running this node calls a model.
 *
 * The ONE place any surface may read this from. It mirrors the engine's
 * dispatch switch (apps/worker-agents/src/engine.ts), and it exists as a
 * function rather than as a note on each node type because no test can span
 * the app boundary to catch the two drifting — so the canvas must at least
 * be reading the same table the runtime does, in the same package.
 *
 * The one node whose answer depends on a FIELD rather than its kind is the
 * loop: `foreach` counts items in code, `until` asks the model after every
 * iteration.
 *
 * An action step with `tool === null` is TRUE, and it is the case most
 * likely to be got backwards: a step with no tool is not a smaller step, it
 * is a step with nothing but the model in it — pure reasoning, with no tool
 * call to ground what comes back.
 */
export function nodeUsesModel(node: AgentStepNode): boolean {
  switch (node.kind) {
    // `undefined` is a v1 action step, from before nodes carried a kind.
    case undefined:
    case 'action':
    case 'branch':
      return true;
    case 'loop':
      return node.mode === 'until';
    case 'group':
    case 'approval':
    case 'terminal':
      return false;
  }
}

/** One enclosing container of a found node, outermost first. */
export type FoundAncestor =
  | { kind: 'branch'; branch: BranchStep; path: BranchPath; isFailurePath: boolean }
  | { kind: 'loop'; loop: LoopStep }
  | { kind: 'group'; group: GroupStep }
  | { kind: 'approval'; approval: ApprovalStep; path: BranchPath; outcome: ApprovalOutcomeKey };

export interface FoundNode {
  node: AgentStepNode;
  /**
   * Containers enclosing the node, outermost first. Because ids are
   * doc-unique, the chain fully determines where execution was — resume
   * needs no persisted path context (loops add an iteration counter, which
   * lives in run rows, not here).
   */
  ancestors: FoundAncestor[];
  /** The sibling list the node sits in, and its index there. */
  siblings: AgentStepNode[];
  index: number;
}

/** Tree search by node id. */
export function findNodeById(nodes: AgentStepNode[], id: string): FoundNode | null {
  const search = (list: AgentStepNode[], ancestors: FoundAncestor[]): FoundNode | null => {
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      if (node.id === id) return { node, ancestors, siblings: list, index };
      switch (node.kind) {
        case 'branch': {
          for (const path of node.paths) {
            const found = search(path.steps, [
              ...ancestors,
              { kind: 'branch', branch: node, path, isFailurePath: false },
            ]);
            if (found) return found;
          }
          if (node.failurePath) {
            const found = search(node.failurePath.steps, [
              ...ancestors,
              { kind: 'branch', branch: node, path: node.failurePath, isFailurePath: true },
            ]);
            if (found) return found;
          }
          break;
        }
        case 'loop': {
          const found = search(node.steps, [...ancestors, { kind: 'loop', loop: node }]);
          if (found) return found;
          break;
        }
        case 'group': {
          const found = search(node.steps, [...ancestors, { kind: 'group', group: node }]);
          if (found) return found;
          break;
        }
        case 'approval': {
          for (const { key, path } of approvalPathsOf(node)) {
            const found = search(path.steps, [
              ...ancestors,
              { kind: 'approval', approval: node, path, outcome: key },
            ]);
            if (found) return found;
          }
          break;
        }
        case 'terminal':
        case 'action':
        case undefined:
          break;
        default: {
          const unhandled: never = node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    }
    return null;
  };
  return search(nodes, []);
}

/** Whether any node in the tree is a branch — the version-2 test. */
export function containsBranch(nodes: AgentStepNode[]): boolean {
  return walkSteps(nodes).some(({ node }) => isBranchStep(node));
}

/**
 * Whether the tree uses anything only a version-3 reader understands:
 * loops, groups, branches with more than two paths or a failure path, or
 * conditionals nested past the frozen v2 depth.
 */
export function containsV3Feature(nodes: AgentStepNode[]): boolean {
  let branchTooDeep = false;
  const visitBranchDepth = (list: AgentStepNode[], branchDepth: number) => {
    for (const node of list) {
      if (node.kind === 'branch') {
        if (branchDepth + 1 > MAX_BRANCH_DEPTH) branchTooDeep = true;
        for (const path of node.paths) visitBranchDepth(path.steps, branchDepth + 1);
        if (node.failurePath) visitBranchDepth(node.failurePath.steps, branchDepth + 1);
      } else if (node.kind === 'loop' || node.kind === 'group') {
        visitBranchDepth(node.steps, branchDepth);
      }
    }
  };
  visitBranchDepth(nodes, 0);
  return (
    branchTooDeep ||
    walkSteps(nodes).some(
      ({ node }) =>
        node.kind === 'loop' ||
        node.kind === 'group' ||
        (node.kind === 'branch' && (node.paths.length !== 2 || node.failurePath !== undefined))
    )
  );
}

/** Whether the tree contains a terminal node — the version-4 test. */
export function containsTerminal(nodes: AgentStepNode[]): boolean {
  return walkSteps(nodes).some(({ node }) => isTerminalStep(node));
}

/** Whether the tree contains an approval node — the version-5 test. */
export function containsApproval(nodes: AgentStepNode[]): boolean {
  return walkSteps(nodes).some(({ node }) => isApprovalStep(node));
}

/** Every instruction-ish segment list a node carries. */
function segmentListsOf(node: AgentStepNode): InstructionSegment[][] {
  switch (node.kind) {
    case 'branch':
      return [node.condition];
    case 'loop':
      return node.mode === 'until' ? [node.condition] : [];
    case 'group':
      return [];
    case 'terminal':
      return [node.message];
    case 'approval':
      return [node.message];
    case 'action':
    case undefined:
      return [node.instruction, ...node.failureHandling.map((entry) => entry.guidance ?? [])];
    default: {
      const unhandled: never = node;
      throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Whether any instruction carries a date chip — the version-6 test. */
export function containsDateChip(nodes: AgentStepNode[]): boolean {
  return walkSteps(nodes).some(({ node }) =>
    segmentListsOf(node).some((segments) => segments.some((segment) => segment.t === 'date'))
  );
}

/**
 * THE version rule — normalizeAgentDraft is its only writer. Anything an
 * older writer could have produced keeps its exact old version, which is
 * what keeps old snapshots byte-stable.
 */
export function requiredVersion(nodes: AgentStepNode[]): 1 | 2 | 3 | 4 | 5 | 6 {
  // Highest first: a date chip renders to a literal only in code that knows
  // what it is, so it outranks every construct below it.
  if (containsDateChip(nodes)) return 6;
  if (containsApproval(nodes)) return 5;
  if (containsTerminal(nodes)) return 4;
  if (containsV3Feature(nodes)) return 3;
  return containsBranch(nodes) ? 2 : 1;
}
