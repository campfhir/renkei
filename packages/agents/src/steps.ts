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
 * `maxAttempts` is the user's TOTAL attempt budget for the step, 1–5. The
 * 5 is a platform ceiling enforced twice: the validator clamps what gets
 * persisted, and the engine re-counts attempt rows in the database before
 * starting another — the snapshot is never the authority.
 */

export type InstructionSegment =
  { t: 'text'; v: string } | { t: 'tool'; name: string } | { t: 'var'; name: string };

export interface FailureHandling {
  /** Failure code from the tool's outcome enumeration, incl. 'other'. */
  outcome: string;
  action: 'retry' | 'exit';
  /**
   * Corrective guidance shown to the model on retry attempts. Required for
   * 'retry'. MAY contain tool chips — several, deliberately laxer than the
   * step body — which become the extra tools offered while correcting.
   */
  guidance?: InstructionSegment[];
}

export interface AgentStep {
  /** uuid, stable across reorders; run records reference it. */
  id: string;
  name: string;
  instruction: InstructionSegment[];
  /** At most one tool; null = reasoning/formatting step. */
  tool: string | null;
  /** Total attempts for this step, 1..MAX_STEP_ATTEMPTS. */
  maxAttempts: number;
  /** Names this step's result; later steps reference it as a var chip. */
  saveAs?: string;
  failureHandling: FailureHandling[];
}

export interface AgentStepsDoc {
  version: 1;
  /** Array order is execution order; success is linear. */
  steps: AgentStep[];
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
  if (entry.action !== 'retry' && entry.action !== 'exit') return false;
  if (entry.guidance !== undefined) {
    if (!Array.isArray(entry.guidance)) return false;
    if (!entry.guidance.every(isInstructionSegment)) return false;
  }
  return true;
}

function isAgentStep(value: unknown): value is AgentStep {
  if (typeof value !== 'object' || value === null) return false;
  const step: {
    id?: unknown;
    name?: unknown;
    instruction?: unknown;
    tool?: unknown;
    maxAttempts?: unknown;
    saveAs?: unknown;
    failureHandling?: unknown;
  } = value;
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
  return true;
}

/**
 * Whether a stored `steps` jsonb value is a document this build executes.
 * Structural only — business rules (attempt clamp, tool existence, variable
 * binding) are the validator's job on the way IN; this guards the way OUT,
 * where the value has already been through it.
 */
export function isAgentStepsDoc(value: unknown): value is AgentStepsDoc {
  if (typeof value !== 'object' || value === null) return false;
  const doc: { version?: unknown; steps?: unknown } = value;
  if (doc.version !== 1) return false;
  return Array.isArray(doc.steps) && doc.steps.every(isAgentStep);
}

/** The tool chips in a segment list, in order of appearance. */
export function toolSegments(segments: InstructionSegment[]): string[] {
  return segments.flatMap((segment) => (segment.t === 'tool' ? [segment.name] : []));
}

/** The var chips in a segment list, in order of appearance. */
export function varSegments(segments: InstructionSegment[]): string[] {
  return segments.flatMap((segment) => (segment.t === 'var' ? [segment.name] : []));
}
