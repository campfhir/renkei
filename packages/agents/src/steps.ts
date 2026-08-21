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
 */

export type InstructionSegment =
  { t: 'text'; v: string } | { t: 'tool'; name: string } | { t: 'var'; name: string };

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
   * The LLM-evaluated yes/no condition. Prose plus var chips; tool chips
   * are rejected by the validator — the evaluator offers no tools.
   */
  condition: InstructionSegment[];
  /** Exactly two, ordered: paths[0] = condition holds, paths[1] = else. */
  paths: [BranchPath, BranchPath];
  /** Attempt budget for the condition evaluation itself. */
  maxAttempts: number;
}

export type AgentStepNode = ActionStep | BranchStep;

export interface AgentStepsDoc {
  /** 2 iff the document contains a branch; 1 otherwise. */
  version: 1 | 2;
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
/** A branch inside a branch is allowed; deeper nesting is not. */
export const MAX_BRANCH_DEPTH = 2;
/** Default attempt budget for a branch's condition evaluation. */
export const BRANCH_DEFAULT_ATTEMPTS = 2;

/**
 * `saveAs` names and API-trigger input names share this shape. Spaces are
 * allowed mid-name ("the ticket", "Find the ticket result") — these are
 * labels people read, not identifiers — but not at either end, which the
 * normalizer's trim guarantees before validation sees them.
 */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/;

export function isInstructionSegment(value: unknown): value is InstructionSegment {
  if (typeof value !== 'object' || value === null) return false;
  const segment: { t?: unknown; v?: unknown; name?: unknown } = value;
  if (segment.t === 'text') return typeof segment.v === 'string';
  if (segment.t === 'tool' || segment.t === 'var') {
    return typeof segment.name === 'string' && segment.name.length > 0;
  }
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

function isBranchPath(value: unknown, depth: number): value is BranchPath {
  if (typeof value !== 'object' || value === null) return false;
  const path: { id?: unknown; name?: unknown; steps?: unknown } = value;
  if (typeof path.id !== 'string' || path.id.length === 0) return false;
  if (typeof path.name !== 'string') return false;
  return Array.isArray(path.steps) && path.steps.every((step) => isNode(step, depth));
}

function isBranchStepShape(value: unknown, depth: number): value is BranchStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    condition?: unknown;
    paths?: unknown;
    maxAttempts?: unknown;
  } = value;
  if (step.kind !== 'branch') return false;
  // Defensive vs pathological jsonb: reject nesting the engine won't run.
  if (depth > MAX_BRANCH_DEPTH) return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (!Array.isArray(step.condition) || !step.condition.every(isInstructionSegment)) return false;
  if (typeof step.maxAttempts !== 'number') return false;
  return (
    Array.isArray(step.paths) &&
    step.paths.length === 2 &&
    step.paths.every((path) => isBranchPath(path, depth + 1))
  );
}

function isNode(value: unknown, depth: number): value is AgentStepNode {
  if (typeof value === 'object' && value !== null) {
    const candidate: { kind?: unknown } = value;
    if (candidate.kind === 'branch') return isBranchStepShape(value, depth);
  }
  return isActionStep(value);
}

/**
 * Whether a stored `steps` jsonb value is a document this build executes.
 * Structural only — business rules (attempt clamp, tool existence, variable
 * binding) are the validator's job on the way IN; this guards the way OUT,
 * where the value has already been through it.
 *
 * The version-1 arm is exactly the pre-branch check: old snapshots parse
 * unchanged, and a v1 doc containing a branch is NOT a valid document.
 */
export function isAgentStepsDoc(value: unknown): value is AgentStepsDoc {
  if (typeof value !== 'object' || value === null) return false;
  const doc: { version?: unknown; steps?: unknown } = value;
  if (doc.version === 1) {
    return Array.isArray(doc.steps) && doc.steps.every(isActionStep);
  }
  if (doc.version === 2) {
    return Array.isArray(doc.steps) && doc.steps.every((step) => isNode(step, 1));
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

/** Depth-first pre-order over every node, branches included. */
export function walkSteps(nodes: AgentStepNode[]): WalkedNode[] {
  const out: WalkedNode[] = [];
  let ordinal = 0;
  const visit = (list: AgentStepNode[], prefix: string, depth: number) => {
    list.forEach((node, index) => {
      const path = `${prefix}.${index}`;
      out.push({ node, path, depth, ordinal });
      ordinal += 1;
      if (isBranchStep(node)) {
        node.paths.forEach((branchPath, pathIndex) => {
          visit(branchPath.steps, `${path}.paths.${pathIndex}.steps`, depth + 1);
        });
      }
    });
  };
  visit(nodes, 'steps', 1);
  return out;
}

/** Every action step in pre-order — for saved-var recovery and previews. */
export function flattenActionSteps(nodes: AgentStepNode[]): ActionStep[] {
  return walkSteps(nodes).flatMap(({ node }) => (isBranchStep(node) ? [] : [node]));
}

/** Total node count — branch nodes count 1 (their evaluation costs a step). */
export function countNodes(nodes: AgentStepNode[]): number {
  return walkSteps(nodes).length;
}

export interface FoundNode {
  node: AgentStepNode;
  /**
   * Branches enclosing the node, outermost first, each with the path the
   * node sits in. Because ids are doc-unique, the chain fully determines
   * where execution was — resume needs no persisted path context.
   */
  ancestors: { branch: BranchStep; path: BranchPath }[];
  /** The sibling list the node sits in, and its index there. */
  siblings: AgentStepNode[];
  index: number;
}

/** Tree search by node id. */
export function findNodeById(nodes: AgentStepNode[], id: string): FoundNode | null {
  const search = (
    list: AgentStepNode[],
    ancestors: { branch: BranchStep; path: BranchPath }[]
  ): FoundNode | null => {
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      if (node.id === id) return { node, ancestors, siblings: list, index };
      if (isBranchStep(node)) {
        for (const path of node.paths) {
          const found = search(path.steps, [...ancestors, { branch: node, path }]);
          if (found) return found;
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
