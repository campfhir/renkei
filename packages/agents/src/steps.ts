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
 *     — success, failure, or a graceful skip — and delivers the
 *     node's own notification (email and/or WebEx, message rendered with
 *     the run's variables). It is the opt-in replacement for the implicit
 *     context-free failure mail: the endpoint says what to send and where.
 *     A leaf: no children, no LLM call, deterministic.
 *
 * VERSION 7 adds no construct — it widens FAILURE HANDLING: an entry may
 * carry `action: 'continue'` (record the failure, move on to the next
 * step) and, on retry entries, an `exhausted` choice for when the attempt
 * budget runs out ('continue' or 'stop-quiet' instead of failing the run).
 *
 * VERSION 9 replaces the standalone approval-pause NODE (versions 5-8) with
 * two narrower primitives — see git history for the removed `ApprovalStep`:
 *   - `needsApproval` — a GATE on an `ActionStep`, not a node of its own.
 *     Before the step's tool call fires, the run pauses, a card proposes
 *     the exact call (tool + rendered args — nothing to author, there is
 *     nothing to say beyond what the step is already about to do), and the
 *     person approves, denies (optionally with a comment), or lets it time
 *     out. Approved calls the tool as normal; denied or timed out — both
 *     "not approved" — take `onNotApproved` (empty = skip the call, carry
 *     on), with `approval.outcome`/`approval.comment` bound for a branch in
 *     that path to tell denied from timed-out if it cares to. One path, not
 *     three: the old node's onDeclined/onTimeout split is judged not worth
 *     the extra authoring surface when a branch already does the same job
 *     on demand. A gate reusing a comment to re-plan and re-ask wraps
 *     itself in a bounded `until` loop (existing primitive) rather than
 *     needing a backward jump — the steps model stays a forward-only tree.
 *   - the agent-level `canAskQuestions` flag (on the agent record, not in
 *     this document at all — see packages/agents/src/index.ts) unlocks a
 *     free `ask_person` tool in EVERY step's turn loop, for a question
 *     whose shape the model only knows at run time: a dynamic form
 *     (`FormNode[]`, packages/agents/src/question-form.ts) built and raised
 *     on demand, no pre-planned node and no loop-of-approvals required.
 * This is a hard replacement, not an additive version: a document
 * containing the old `{kind:"approval"}` shape no longer parses as a
 * steps document at all (`isAgentStepsDoc` rejects it, same as any other
 * structurally invalid value) rather than loading read-only for editing.
 *
 * `requiredVersion` (validate.ts) is the single version rule: 9 iff any
 * step sets `needsApproval`, else 7 iff any failure handling uses the v7
 * vocabulary, else 6 iff a date chip is present, else 4 iff a terminal node
 * is, else 3 iff any v3 construct is, else 2 iff a branch exists, else 1 —
 * so every document any older writer could produce keeps its exact old
 * version and bytes.
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

/**
 * A `var` segment inserts that variable's CURRENT value VERBATIM — there is
 * no formatting step in between. A variable an earlier action step saved
 * for a LATER step to parse (a raw loop item, a pipe-delimited or
 * JSON-shaped record built as an internal hand-off) renders exactly that
 * way in a message a PERSON reads too, if that is the variable a
 * person-facing `message` (a terminal node, or the prompt context a gate's
 * `onNotApproved` path or `ask_person` builds) names.
 *
 * A message meant for a person should reference a variable that already
 * holds plain prose written FOR a person — add a `tool: null` reasoning
 * step right before the point it is used that turns the raw value into a
 * one- or two-sentence summary and saves that under its own name, then put
 * that name in the message instead of the raw one. This matters most
 * inside a loop, where each round's "current item" is exactly the kind of
 * internal record this warns about.
 */
export type InstructionSegment =
  { t: 'text'; v: string } | { t: 'tool'; name: string } | { t: 'var'; name: string } | DateSegment;

export interface FailureHandling {
  /** Failure code from the tool's outcome enumeration, incl. 'other'. */
  outcome: string;
  /**
   * 'exit' fails the run (the default for unhandled codes); 'retry' tries
   * again with guidance; 'stop-quiet' declares the outcome NOT an error —
   * "ticket not found" is sometimes a reason to skip the rest — and ends
   * the run gracefully as 'stopped': silent like onSuccess 'stop-quiet'
   * (no reply, no notification, no chained agents), recorded in run
   * history only. 'continue' (version 7) records the failure on the
   * attempt row but moves on to the next step anyway — the step's saved
   * result, when it names one, binds to the failure summary so later
   * steps and branches can see what happened.
   */
  action: 'retry' | 'exit' | 'stop-quiet' | 'continue';
  /**
   * The author's prose for this condition. On 'retry' it is the corrective
   * guidance shown to the model on retry attempts (required, and MAY
   * contain tool chips — several, deliberately laxer than the step body —
   * which become the extra tools offered while correcting). On every other
   * action (version 8) it is advisory: rendered into the attempt-1 outcome
   * guide and the outlines so the step model and the reviewer both see
   * what the author meant by handling this condition the way they did.
   */
  guidance?: InstructionSegment[];
  /**
   * Version 7, meaningful only with action 'retry': what to do when the
   * attempt budget runs out with this condition still the last failure.
   * Absent/'exit' fails the run (the pre-v7 behavior); 'continue' moves on
   * to the next step; 'stop-quiet' ends the run gracefully as 'stopped'.
   * The normalizer strips an explicit 'exit' so documents that keep the
   * default stay byte-identical with what older writers produce.
   */
  exhausted?: 'exit' | 'stop-quiet' | 'continue';
  /**
   * Version 8: plain-text description of a CUSTOM condition — one the
   * step's tool does not enumerate, judged by the step model reasoning
   * over the result ("the results don't match the description closely
   * enough"). Present exactly when `outcome` is an author-invented code;
   * validation rejects it on enumerated codes and requires it on custom
   * ones. Never trimmed — an over-long description is a validation issue,
   * not a silent clip.
   */
  when?: string;
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
  /**
   * Version 9: pause and ask a person before THIS step's tool call fires.
   * Meaningless without `tool` set — the validator rejects it on a
   * reasoning-only step, since there is no call to gate. See the header
   * doc's VERSION 9 note for the full pause/resume story and why this
   * replaced the standalone approval node.
   */
  needsApproval?: boolean;
  /**
   * How long the run may wait, in hours — default
   * APPROVAL_DEFAULT_TIMEOUT_HOURS, clamped by the org's
   * agentApprovalMaxWaitDays cap at save AND live at pause time, same rule
   * the old approval node used. Meaningless without `needsApproval`.
   */
  approvalTimeoutHours?: number;
  /**
   * Taken when the decision is 'denied' OR the wait times out — both read
   * as "not approved" here; there is no separate onTimeout path. Empty or
   * absent = skip the tool call and continue to the next step. The
   * decision (`approval.outcome`: 'approved' | 'denied' | 'timedOut') and
   * the person's optional `approval.comment` are bound as vars for a
   * branch inside this path to read, if the author wants denied and
   * timed-out handled differently. Meaningless without `needsApproval`.
   */
  onNotApproved?: BranchPath;
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
   *
   * This is also the mechanism a `needsApproval` gate uses to react to a
   * denial's comment WITHOUT a backward jump: wrap "decide the value →
   * gated step" in an until-loop whose condition reads `approval.outcome`
   * — a denial drives another bounded round, replanning with the comment
   * now in scope as a variable. The steps model stays a forward-only tree.
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
 * 'stop' is the graceful skip ending (run status 'stopped').
 */
export type TerminalResult = 'success' | 'failure' | 'stop';

export interface TerminalStep {
  /** uuid, same doc-wide id space as every node. */
  id: string;
  kind: 'terminal';
  name: string;
  result: TerminalResult;
  /**
   * A note on why the run ended here — prose + var chips (never tool
   * chips), rendered with the run's live variables so it carries real
   * context. Optional; shown on the run's own timeline as `terminalMessage`.
   * Not a notification: an owner's "what should I hear about" preferences
   * live in @renkei/user-prefs, not on the agent's own steps. See the `var`
   * segment's doc on InstructionSegment: a chip here renders verbatim, so
   * it should name a variable already written FOR a person.
   */
  message: InstructionSegment[];
}

/**
 * What one QUESTION control collects — used by the agent-level
 * `ask_person` tool's dynamic form (packages/agents/src/question-form.ts),
 * never by a `needsApproval` gate: a gate is a plain approve/deny/comment
 * decision, nothing about its shape is knowable at authoring time the way
 * a pre-planned form's fields are, so it has no fields of its own.
 *
 * 'text' and 'longtext' differ only in the control's height — both bind a
 * string. The other four exist because the answer's SHAPE is knowable when
 * the model builds the form and it should not have to parse for it: a
 * number arrives as digits, a choice arrives as one of the options given,
 * a date arrives as YYYY-MM-DD. What cannot be checked at the card is still
 * the agent's job — "CIO-12" is a well-formed string and a wrong issue
 * either way.
 */
export type QuestionFieldType = 'text' | 'longtext' | 'number' | 'choice' | 'multi' | 'date';

export interface QuestionField {
  /**
   * The variable this field binds. Two fields in the same form cannot
   * share a name, and neither can a field and a saved result.
   *
   * It is also the KEY an answer comes back under. A form is a key/value
   * reply and this is the key — there is deliberately no id beside it. An
   * id would survive renaming a field while a card waits behind it, which
   * sounds worth having until you notice that renaming a binding already
   * breaks every chip referencing it. Paying for that everywhere — uuids
   * in hand-built JSON, a name→id map at every boundary — buys consistency
   * in one rare window and costs legibility in all of them.
   */
  name: string;
  /** What the person is asked for, rendered above the control. */
  label: string;
  /**
   * What the DESTINATION calls this, when the answer is headed somewhere
   * that has its own identifier: `customfield_10016` for Story Points,
   * a column name, a form id. Optional, opaque, and never interpreted
   * here — it rides along so the step that writes the answer has the key
   * and the value together ("Story Points [customfield_10016]: 8")
   * instead of resolving a display name at run time and hoping.
   */
  key?: string;
  type: QuestionFieldType;
  /** Nothing sends until it has a value. */
  required: boolean;
  /** choice/multi: what the card offers, and the only values it accepts. */
  options?: string[];
  /** number: inclusive bounds, enforced at the card and on submit. */
  min?: number;
  max?: number;
  /** A line under the control — units, format, where to look it up. */
  help?: string;
}

/** How many controls one form may carry. A form, not a questionnaire. */
export const MAX_QUESTION_FIELDS = 10;
export const MAX_QUESTION_FIELD_OPTIONS = 25;
export const MAX_QUESTION_FIELD_LABEL_CHARS = 200;
export const MAX_QUESTION_FIELD_OPTION_CHARS = 200;
export const MAX_QUESTION_FIELD_HELP_CHARS = 500;
export const MAX_QUESTION_FIELD_KEY_CHARS = 200;

export type AgentStepNode = ActionStep | BranchStep | LoopStep | GroupStep | TerminalStep;

export interface AgentStepsDoc {
  /**
   * CURRENT_STEPS_VERSION on everything this build writes. Older numbers
   * still LOAD (so the builder can open a stale agent for updating) but
   * never RUN — see isCurrentStepsDoc. The one exception: a document that
   * still contains the removed `{kind:"approval"}` node shape does not
   * load at all (see the header doc's VERSION 9 note) — there is no
   * version number for it to fall back to.
   */
  version: number;
  /** Array order is execution order; success is linear within a list. */
  steps: AgentStepNode[];
}

/**
 * The DEFAULT ceiling on a step's total attempts. The real ceiling is the
 * org's `agentMaxStepAttempts` setting, which may exceed this; this value
 * binds only where no settings are in hand.
 */
export const MAX_STEP_ATTEMPTS = 10;
/**
 * The DEFAULT ceiling on an agent's step count. Like MAX_STEP_ATTEMPTS
 * above, the real ceiling is the org's `agentMaxSteps` setting (the save
 * path passes it into validateAgentDraft); this value binds only where no
 * settings are in hand.
 */
export const MAX_STEPS = 20;
export const MAX_INSTRUCTION_CHARS = 4_000;
/**
 * Sanity bounds on outcome-line prose, NOT trims: like the guardrails cap
 * below, these exist so a paste accident cannot park a megabyte in every
 * prompt — an over-cap value is a validation issue the author sees and
 * fixes, and no code path may silently truncate either field.
 */
export const MAX_GUIDANCE_CHARS = 20_000;
export const MAX_OUTCOME_WHEN_CHARS = 1_000;
/** Custom condition codes: short kebab-case slugs, e.g. "stale-data". */
export const CUSTOM_OUTCOME_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_OUTCOME_CODE_CHARS = 64;

/**
 * A "when …" description → the kebab-case code it is stored under. The
 * builder and the drafting parser both derive codes with this, so the same
 * description lands on the same code wherever it is authored. Returns ''
 * when nothing sluggable survives — callers fall back or refuse.
 */
export function customOutcomeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, MAX_OUTCOME_CODE_CHARS)
    .replace(/-+$/, '');
}
/** Conditionals may nest three deep. */
export const MAX_BRANCH_DEPTH_V3 = 3;
/**
 * Version 3's combined containment ceiling: branch, loop and gate-recovery
 * levels count, groups do not — a loop wrapped around three nested
 * branches is legal and is the deepest legal shape.
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
/**
 * Default wait ceiling a `needsApproval` gate (or an `ask_person` call
 * that doesn't set its own) seeds: four days.
 */
export const APPROVAL_DEFAULT_TIMEOUT_HOURS = 96;
/**
 * The approval wait cap used when no org settings are in hand — matches
 * the org setting's default (agentApprovalMaxWaitDays = 14). The live
 * setting binds at save (normalizeAgentDraft option) and again at pause.
 * Shared by `needsApproval` gates and `ask_person` calls alike.
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

/** Structural check for a failure-handling entry. */
function isFailureHandling(value: unknown): value is FailureHandling {
  if (typeof value !== 'object' || value === null) return false;
  const entry: {
    outcome?: unknown;
    action?: unknown;
    guidance?: unknown;
    exhausted?: unknown;
    when?: unknown;
  } = value;
  if (typeof entry.outcome !== 'string' || entry.outcome.length === 0) return false;
  if (entry.when !== undefined && typeof entry.when !== 'string') return false;
  if (
    entry.action !== 'retry' &&
    entry.action !== 'exit' &&
    entry.action !== 'stop-quiet' &&
    entry.action !== 'continue'
  ) {
    return false;
  }
  if (entry.guidance !== undefined) {
    if (!Array.isArray(entry.guidance)) return false;
    if (!entry.guidance.every(isInstructionSegment)) return false;
  }
  if (
    entry.exhausted !== undefined &&
    entry.exhausted !== 'exit' &&
    entry.exhausted !== 'stop-quiet' &&
    entry.exhausted !== 'continue'
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

/** An action step (the default — `kind` is absent on every v1 document). */
export function isActionStepNode(node: AgentStepNode): node is ActionStep {
  return node.kind === undefined || node.kind === 'action';
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
export type NodeKind = 'action' | 'branch' | 'loop' | 'group' | 'terminal';

export function nodeKind(node: AgentStepNode): NodeKind {
  return node.kind ?? 'action';
}

/**
 * Form fields out of untrusted JSON — a `'question'` card stores a
 * SNAPSHOT of the run-time form the model built so the feed can render
 * controls without re-reading the run, and this reads one field list back
 * out of it (question-form.ts's `parseFormNodes` reads the whole tree,
 * groups and paragraphs included; this is the flat-list half other
 * consumers — answer checking, the old single-list card — still want).
 * Anything malformed is dropped rather than thrown on: a card whose spec
 * cannot be read still has to render as something a person can answer.
 */
export function parseQuestionFields(value: unknown): QuestionField[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isQuestionField).slice(0, MAX_QUESTION_FIELDS);
}

/* ---------------- structural node guard ----------------------------- */
/* ONE guard for every stored document. Current shapes are supersets of  */
/* every version this product ever wrote, so an old doc's NODES always   */
/* pass — the version NUMBER decides whether it may RUN (see             */
/* isCurrentStepsDoc): old versions load in the builder for updating,    */
/* and the runtime disables the agent and tells the owner to re-save.    */
/* The one exception is the removed approval node — see the header doc's */
/* VERSION 9 note: a document containing one no longer parses at all.    */

/** Containment counters the v3+ shape checks thread through the tree. */
interface GuardContext {
  /** Nested branch levels entered so far. */
  branchDepth: number;
  /** Branch + loop + gate-recovery levels entered so far (groups are free). */
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
  // Extra properties (a `notifyEmail`/`notifyWebex` pair from a doc saved
  // before that feature was removed) are simply ignored here, same as any
  // other unrecognized field — the shape check only requires what a
  // TerminalStep still needs.
  const step: {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    result?: unknown;
    message?: unknown;
  } = value;
  if (step.kind !== 'terminal') return false;
  if (typeof step.id !== 'string' || step.id.length === 0) return false;
  if (typeof step.name !== 'string') return false;
  if (step.result !== 'success' && step.result !== 'failure' && step.result !== 'stop') {
    return false;
  }
  return Array.isArray(step.message) && step.message.every(isInstructionSegment);
}

const QUESTION_FIELD_TYPES = new Set<string>([
  'text',
  'longtext',
  'number',
  'choice',
  'multi',
  'date',
]);

/** One form field, structurally. Business rules are the validator's. */
export function isQuestionField(value: unknown): value is QuestionField {
  if (typeof value !== 'object' || value === null) return false;
  const field: {
    name?: unknown;
    label?: unknown;
    key?: unknown;
    type?: unknown;
    required?: unknown;
    options?: unknown;
    min?: unknown;
    max?: unknown;
    help?: unknown;
  } = value;
  if (typeof field.name !== 'string') return false;
  if (typeof field.label !== 'string') return false;
  if (field.key !== undefined && typeof field.key !== 'string') return false;
  if (typeof field.type !== 'string' || !QUESTION_FIELD_TYPES.has(field.type)) return false;
  if (typeof field.required !== 'boolean') return false;
  if (
    field.options !== undefined &&
    (!Array.isArray(field.options) || !field.options.every((option) => typeof option === 'string'))
  ) {
    return false;
  }
  if (field.min !== undefined && typeof field.min !== 'number') return false;
  if (field.max !== undefined && typeof field.max !== 'number') return false;
  if (field.help !== undefined && typeof field.help !== 'string') return false;
  return true;
}

/**
 * Structural check for an action step, INCLUDING the `needsApproval` gate
 * fields — `onNotApproved` nests other nodes, so (unlike before version 9)
 * this needs the same context-threading every container check gets.
 */
function isActionStepShape(
  value: unknown,
  context: GuardContext,
  isNode: NodeShapeCheck
): value is ActionStep {
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
    needsApproval?: unknown;
    approvalTimeoutHours?: unknown;
    onNotApproved?: unknown;
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
  if (step.needsApproval !== undefined && typeof step.needsApproval !== 'boolean') return false;
  if (step.approvalTimeoutHours !== undefined && typeof step.approvalTimeoutHours !== 'number') {
    return false;
  }
  if (step.onNotApproved !== undefined) {
    // Gate recovery consumes a container-depth level, same budget a loop
    // or group level costs — not a branch level, since nothing is being
    // DECIDED here, just recovered from.
    const inner: GuardContext = {
      branchDepth: context.branchDepth,
      containerDepth: context.containerDepth + 1,
      inLoop: context.inLoop,
    };
    if (inner.containerDepth > MAX_CONTAINER_DEPTH) return false;
    if (!isBranchPathV3(step.onNotApproved, inner, isNode)) return false;
  }
  return true;
}

function isNode(value: unknown, context: GuardContext): value is AgentStepNode {
  if (typeof value === 'object' && value !== null) {
    const candidate: { kind?: unknown } = value;
    if (candidate.kind === 'branch') return isBranchStepShapeV3(value, context, isNode);
    if (candidate.kind === 'loop') return isLoopStepShape(value, context, isNode);
    if (candidate.kind === 'group') return isGroupStepShape(value, context, isNode);
    if (candidate.kind === 'terminal') return isTerminalStepShape(value);
    // The removed approval node: reject explicitly rather than falling
    // through to isActionStepShape, which would refuse it anyway (kind
    // mismatch) but with a less legible reason if anyone goes looking.
    if (candidate.kind === 'approval') return false;
  }
  return isActionStepShape(value, context, isNode);
}

/**
 * The one version this build WRITES and RUNS. There is deliberately no
 * per-version maintenance: the normalizer stamps every save with this,
 * run creation demands it (isCurrentStepsDoc), and an agent found carrying
 * an older number is disabled with a notification telling the owner to
 * open it in the builder and save — which re-stamps it. History, for the
 * curious: 9 approval gate + agent-level questions (replacing the
 * standalone approval node), 8 outcome prose/custom conditions, 7
 * continue-handling, 6 date chips, 5 the now-removed approval node
 * (versions 5-8 could carry it), 4 terminals, 3 loops/groups/n-way
 * branches, 2 branches, 1 linear steps.
 */
export const CURRENT_STEPS_VERSION = 9;

/**
 * Whether a stored `steps` jsonb value is structurally a steps document.
 * Structural only — business rules (attempt clamp, tool existence,
 * variable binding) are the validator's job on the way IN; this guards the
 * way OUT. The version number is accepted for ANY integer 1..current:
 * today's node shapes are supersets of every version this product ever
 * wrote, so old documents still LOAD (the builder needs them to, so an
 * owner can update a stale agent) — whether a document may RUN is
 * isCurrentStepsDoc's stricter question. The one exception is the removed
 * approval node (versions 5-8): a document containing one fails this
 * structural guard outright and does not load, since there is no reader
 * left for its shape.
 */
export function isAgentStepsDoc(value: unknown): value is AgentStepsDoc {
  if (typeof value !== 'object' || value === null) return false;
  const doc: { version?: unknown; steps?: unknown } = value;
  if (
    typeof doc.version !== 'number' ||
    !Number.isInteger(doc.version) ||
    doc.version < 1 ||
    doc.version > CURRENT_STEPS_VERSION
  ) {
    return false;
  }
  const root: GuardContext = { branchDepth: 0, containerDepth: 0, inLoop: false };
  return Array.isArray(doc.steps) && doc.steps.every((step) => isNode(step, root));
}

/**
 * The gate at every RUN-CREATION site (manual invoke, rerun, schedules,
 * event fan-out, chaining): only current-version documents start runs.
 * Snapshot readers stay on the permissive isAgentStepsDoc so in-flight
 * runs finish and history renders; the maintenance sweep disables agents
 * that fail this and notifies their owners to update.
 */
export function isCurrentStepsDoc(value: unknown): value is AgentStepsDoc {
  return isAgentStepsDoc(value) && value.version === CURRENT_STEPS_VERSION;
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
        case 'terminal':
          break;
        case 'action':
        case undefined:
          if (node.onNotApproved) {
            visit(node.onNotApproved.steps, `${path}.onNotApproved.steps`, depth + 1);
          }
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
  return walkSteps(nodes).flatMap(({ node }) => (isActionStepNode(node) ? [node] : []));
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
    case 'terminal':
      return false;
  }
}

/** One enclosing container of a found node, outermost first. */
export type FoundAncestor =
  | { kind: 'branch'; branch: BranchStep; path: BranchPath; isFailurePath: boolean }
  | { kind: 'loop'; loop: LoopStep }
  | { kind: 'group'; group: GroupStep }
  | { kind: 'gate'; step: ActionStep; path: BranchPath };

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
        case 'terminal':
          break;
        case 'action':
        case undefined:
          if (node.onNotApproved) {
            const found = search(node.onNotApproved.steps, [
              ...ancestors,
              { kind: 'gate', step: node, path: node.onNotApproved },
            ]);
            if (found) return found;
          }
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

/**
 * Whether the tree contains a `needsApproval` gate. Decides whether the
 * `approval.outcome`/`approval.comment`/`approval.link` builtin variables
 * are offered — the direct successor of the old `containsApproval`, which
 * asked the same question of the removed approval node.
 */
export function containsApprovalGate(nodes: AgentStepNode[]): boolean {
  return walkSteps(nodes).some(({ node }) => isActionStepNode(node) && node.needsApproval === true);
}
