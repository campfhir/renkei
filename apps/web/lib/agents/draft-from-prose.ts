/**
 * One block of prose → a drafted step list, chips included.
 *
 * The user describes the whole automation in their own words; the org
 * model splits it into steps and marks tools/variables with {{tool:x}} /
 * {{var:y}} tokens. That token syntax exists ONLY on this wire — parsing
 * here turns it into the segment arrays the builder edits, and every
 * token is verified: a tool the caller does not have becomes plain text,
 * never a chip the validator would bounce. The user reviews and edits the
 * result in the builder like anything they typed themselves; nothing is
 * saved by this step.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  BUILTIN_VARIABLES,
  MAX_BRANCH_DEPTH,
  flattenActionSteps,
  isBranchStep,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type BranchPath,
  type FailureHandling,
  type InstructionSegment,
} from '@renkei/agents';
import { resolveAgentLlm, type LlmMessage } from '@renkei/agent-llm';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { friendlyToolName } from '@/lib/tool-name';
import { logger } from '@/lib/logger';

// Generous on purpose: reasoning models (Foundry deployments especially)
// routinely take over a minute on a long description, and cutting them off
// wastes the whole spend. The builder shows staged progress meanwhile.
const DRAFT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_PROSE_CHARS = 4_000;

/** Segments → the wire's token syntax, so current steps round-trip exactly. */
function segmentsToTokens(segments: InstructionSegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.t) {
        case 'text':
          return segment.v;
        case 'tool':
          return `{{tool:${segment.name}}}`;
        case 'var':
          return `{{var:${segment.name}}}`;
      }
    })
    .join('');
}

/**
 * Current nodes → the numbered sN lines revisions quote. Pre-order over the
 * whole tree so `from` ids can name nodes inside branch paths too.
 */
function currentLinesOf(nodes: AgentStepNode[]): string {
  return walkSteps(nodes)
    .map(({ node, ordinal, depth }) => {
      const indent = '  '.repeat(depth - 1);
      if (isBranchStep(node)) {
        return (
          `${indent}s${ordinal + 1}. [branch] "${node.name}" — decides: ${segmentsToTokens(node.condition)}` +
          ` (if yes → "${node.paths[0].name}", otherwise → "${node.paths[1].name}"; the indented steps below belong to those paths)`
        );
      }
      return (
        `${indent}s${ordinal + 1}. "${node.name}" — ${segmentsToTokens(node.instruction)}` +
        (node.saveAs ? ` (saves result as "${node.saveAs}")` : '')
      );
    })
    .join('\n');
}

/** A trigger-provided variable with the catalog's explanation of what it is. */
export interface TriggerVarInfo {
  name: string;
  description: string;
}

function promptOf(
  text: string,
  tools: ToolDescriptor[],
  currentSteps: AgentStepNode[],
  triggerVars: TriggerVarInfo[]
): string {
  const toolLines = tools
    .filter((tool) => !tool.appOnly)
    .map(
      (tool) =>
        `- ${tool.name} (${friendlyToolName(tool.name, tool.title)}): ${(tool.description ?? '').slice(0, 100)}` +
        ` | failure codes: ${tool.outcomes.failures.map((failure) => failure.code).join(', ')}`
    )
    .join('\n');
  const varLines = [
    ...BUILTIN_VARIABLES.map((variable) => `- ${variable.name}: ${variable.description}`),
    ...triggerVars.map((variable) => `- ${variable.name}: ${variable.description}`),
  ].join('\n');

  const revising = currentSteps.length > 0;
  const currentLines = currentLinesOf(currentSteps);

  return [
    revising
      ? 'A user wants to CHANGE an existing automation. Apply exactly the change they describe — add, remove, reorder, or tweak steps as asked — and return the FULL revised step list. Echo steps the change does not touch VERBATIM (same instruction tokens, same saveAs).'
      : 'A user described an automation in plain words. Split it into ordered steps for a step-runner.',
    'Rules:',
    '- Each step does ONE thing and may use AT MOST ONE tool from the list below (a step may also be pure reasoning with no tool).',
    '- When a step covers MANY items (a sprint of issues, a folder of mail, a search result set), choose the bulk tool (named *_bulk_*) or a single search over per-item tools — one step, one call, never one step per item.',
    '- Mark the tool in the instruction as {{tool:tool_name}} and reference known variables as {{var:name}}. Use ONLY tools and variables from the lists.',
    '- When a later step needs an earlier step\'s result, give the earlier step a short "saveAs" name (starts with a letter; then letters, numbers, spaces, ".", "-" or "_"; at most 64 characters — e.g. "the ticket") and reference it as {{var:the ticket}}.',
    '- Every "saveAs" name must be UNIQUE — never reuse a name across steps. Later references use the exact earlier name.',
    '- When the description says the flow ENDS at a step on success, set that step\'s "onSuccess" to "stop"; when it should end silently doing nothing (no reply, no follow-up — e.g. "if it\'s not relevant, ignore it"), use "stop-quiet". For CONDITIONAL endings keep the condition in the instruction words ("If …, … and stop here" / "…stop silently") — the runner honors those at runtime.',
    '- Steps run strictly in order — but people rarely DESCRIBE them in order ("before all that ' +
      'you might need to…", "first look up…"). Reorder into the true execution sequence: gather ' +
      'context first, look things up, then act on what was found.',
    '- When the description forks on a condition ("if a ticket exists, comment on it; ' +
      'otherwise create one"), use a BRANCH object in the steps array: {"kind": "branch", ' +
      '"name": short label, "condition": a yes/no question in plain words (may use ' +
      '{{var:...}}, NEVER {{tool:...}} — do any tool work in a step BEFORE the branch and ' +
      'save the result), "ifLabel"/"elseLabel": short path names, "ifSteps"/"elseSteps": ' +
      'arrays of steps (same shape as top-level steps; either may be empty — an empty ' +
      'elseSteps just continues). After either path finishes, the automation continues with ' +
      'the steps AFTER the branch. A branch may contain one more level of branch inside its ' +
      "paths, never deeper. Small conditions that only tweak wording stay INSIDE a step's " +
      'instruction ("If nothing was found, say so briefly"); use a branch when the two ' +
      'outcomes need DIFFERENT steps or tools. Never invent jump-to-step logic.',
    '- Carry the user\'s guardrails into the step that acts (e.g. "if this thread was already ' +
      'handled, do not update the same ticket again — stop instead").',
    '- A step that FAILS stops the automation by default. To handle a specific failure of a ' +
      'tool step differently, add it to that step\'s "failures" array using one of the tool\'s ' +
      'listed failure codes: {"outcome": code, "action": "stop"} stops deliberately, ' +
      '{"outcome": code, "action": "retry", "guidance": "corrective instruction"} retries with ' +
      'that guidance, and {"outcome": code, "action": "stop-quiet"} declares the condition NOT ' +
      'an error (e.g. "nothing found" just means there is nothing to do) — the run ends ' +
      'silently and shows as stopped rather than failed. Guidance may use {{var:...}} and ' +
      '{{tool:...}} chips — guidance tools become available to the step ONLY on retries (the ' +
      'corrective set). Unlisted codes stop.',
    '- When the user\'s description implies retrying (e.g. "search again with different ' +
      'keywords"), express it as a "retry" failure handling with that guidance, and set "tries" ' +
      'to how many total attempts make sense (1-10, default 5).',
    ...(revising
      ? [
          '- Every returned step carries "from": the sN id of the existing step it is based on (kept or tweaked), or null for a brand-new step. Unchanged and tweaked steps MUST carry their id — it preserves the owner\'s retry settings.',
          '',
          'The automation currently has these steps:',
          currentLines,
        ]
      : []),
    '',
    'Available tools:',
    toolLines,
    '',
    "Available variables (trigger.* variables describe the event that starts the automation — pass the id-shaped ones to the matching connector tool to act on that item, e.g. reply where a message came from by giving its space/room id variable to that connector's send tool). Use ONLY these variable names. Never invent trigger.* names: if the described automation reacts to an event but no matching trigger.* variable is listed, write the step in plain words instead — the user must attach that trigger in the builder before its data exists:",
    varLines,
    '',
    revising ? 'The user asked for this change:' : 'The user wrote:',
    '"""',
    text,
    '"""',
    '',
    'Reply with ONLY a JSON object — no code fences, no commentary before or after — in',
    'exactly this structure:',
    '{',
    '  "name": string — a short agent name, at most 60 characters,',
    '  "steps": array of 1 to 20 objects, in execution order, each:',
    '  {',
    '    "name": string — a short step label, at most 80 characters, never empty,',
    '    "instruction": string — the plain-words instruction with {{tool:...}} and',
    '      {{var:...}} tokens inline; never empty,',
    '    "tool": string or null — EXACTLY the tool_name inside the instruction\'s',
    '      {{tool:...}} token, or null for a reasoning step with no tool,',
    '    "saveAs": string or null — a short result name when later steps reference it',
    '      (starts with a letter; then letters, numbers, spaces, ".", "-" or "_";',
    '      at most 64 characters), otherwise null,',
    '    "tries": integer 1-10 or omitted — total attempts for this step (default 5),',
    '    "onSuccess": "continue" (default), "stop" (the automation ends here successfully),',
    '      or "stop-quiet" (ends silently: no reply, no follow-up automations),',
    '    "failures": array or omitted — only meaningful on tool steps; each entry:',
    '      { "outcome": one of the tool\'s failure codes,',
    '        "action": "stop", "retry", or "stop-quiet" (not an error — end the run',
    '          silently),',
    '        "guidance": string (required when action is "retry"; plain words, may use',
    '          {{tool:...}} and {{var:...}} tokens) or null }' + (revising ? ',' : ''),
    ...(revising
      ? [
          '    "from": string or null — the sN id of the existing step this one is based',
          '      on, or null for a brand-new step',
        ]
      : []),
    '  }',
    '  A steps array entry may INSTEAD be a branch:',
    '  {',
    '    "kind": "branch",',
    '    "name": string — a short label for the decision, never empty,',
    '    "condition": string — a yes/no question in plain words; {{var:...}} allowed,',
    '      {{tool:...}} forbidden,',
    '    "ifLabel": string — short name for the yes path (e.g. "A ticket exists"),',
    '    "elseLabel": string — short name for the no path (e.g. "Otherwise"),',
    '    "ifSteps": array of steps (may be empty),',
    '    "elseSteps": array of steps (may be empty; not both empty)' + (revising ? ',' : ''),
    ...(revising ? ['    "from": string or null — the sN id of the existing branch, or null'] : []),
    '  }',
    '}',
    'Every field must be present on every step. Do not add fields not listed here.',
  ].join('\n');
}

const TOKEN_PATTERN = /\{\{(tool|var):([^}]{1,128})\}\}/g;

/** Token string → segments, keeping only chips that verify. */
function segmentsOf(
  instruction: string,
  validTools: Set<string>,
  knownVars: Set<string>,
  // Guidance is the deliberately laxer corrective set — several tool chips
  // are legal there, where a step instruction takes at most one.
  allowMultipleTools = false
): InstructionSegment[] {
  const segments: InstructionSegment[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.t === 'text') last.v += value;
    else segments.push({ t: 'text', v: value });
  };

  let cursor = 0;
  let toolPlaced = false;
  for (const match of instruction.matchAll(TOKEN_PATTERN)) {
    pushText(instruction.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;
    const [, kind, rawName] = match;
    const name = rawName.trim();
    if (kind === 'tool' && validTools.has(name) && (allowMultipleTools || !toolPlaced)) {
      segments.push({ t: 'tool', name });
      toolPlaced = true;
    } else if (kind === 'var' && knownVars.has(name)) {
      // trigger.* names get no free pass: a chip naming trigger data no
      // attached trigger provides would bounce at save ("not something this
      // agent knows"), so it degrades to text like any other unknown var.
      segments.push({ t: 'var', name });
    } else {
      // An invented tool, a duplicate tool chip, or an unknown variable:
      // keep the words, drop the chip — the builder shows text the user
      // can re-chip deliberately.
      pushText(name);
    }
  }
  pushText(instruction.slice(cursor));
  return segments;
}

/**
 * The retry feedback for a {{var:trigger.*}} chip nothing provides: name the
 * trigger variables that DO exist so the corrective round trip can pick one,
 * or say plainly that a trigger must be attached first.
 */
function unknownTriggerVarProblem(label: string, name: string, knownVars: Set<string>): string {
  const available = [...knownVars].filter((known) => known.startsWith('trigger.'));
  return (
    `${label} uses {{var:${name}}}, but no attached trigger provides it — ` +
    (available.length > 0
      ? `the available trigger variables are: ${available.join(', ')}.`
      : 'no trigger is attached, so no trigger.* variables exist; write the step in plain words (the user attaches the trigger in the builder).')
  );
}

/**
 * Coerce a model-authored saveAs into VARIABLE_NAME_PATTERN shape (letter
 * first; letters, numbers, spaces, ".", "-", "_"; ≤64 chars) so a draft can
 * never bounce at save on a result name. Returns '' when nothing survives.
 */
function sanitizeSaveAs(raw: string): string {
  let name = raw
    .trim()
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^[^A-Za-z]+/, '');
  return name.slice(0, 64).trim();
}

export interface DraftedAgent {
  name: string;
  steps: AgentStepNode[];
}

/**
 * The reply's structural contract, as zod schemas — the same shapes the
 * prompt describes in words. Validated in two layers so one malformed step
 * does not void nine good ones: the envelope must hold, then each step is
 * checked individually and broken ones become per-step feedback.
 */
const REPLY_ENVELOPE = z.object({
  name: z.string().optional(),
  steps: z.array(z.unknown()).min(1, 'must contain at least one step').max(20),
});

const STEP_SHAPE = z.object({
  name: z.string().optional(),
  instruction: z.string().trim().min(1, 'is required and must be a non-empty string'),
  tool: z.string().nullable().optional(),
  saveAs: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  tries: z.number().int().min(1).max(10).optional(),
  onSuccess: z.enum(['continue', 'stop', 'stop-quiet']).optional(),
  failures: z
    .array(
      z.object({
        outcome: z.string().min(1, 'must be a failure code'),
        action: z.enum(['stop', 'retry', 'stop-quiet']),
        guidance: z.string().nullable().optional(),
      })
    )
    .optional(),
});

/**
 * The branch wire shape. Its path arrays stay unknown[] here — each entry
 * is checked individually by the recursive parse, so one malformed nested
 * step degrades to feedback instead of voiding the whole branch.
 */
const BRANCH_SHAPE = z.object({
  kind: z.literal('branch'),
  name: z.string().trim().min(1, 'is required and must be a non-empty string'),
  condition: z.string().trim().min(1, 'is required and must be a non-empty string'),
  ifLabel: z.string().optional(),
  elseLabel: z.string().optional(),
  ifSteps: z.array(z.unknown()),
  elseSteps: z.array(z.unknown()),
  from: z.string().nullable().optional(),
});

function isBranchWire(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate: { kind?: unknown } = entry;
  return candidate.kind === 'branch';
}

/** zod issues → the quotable one-liners the retry feedback is built from. */
function zodProblems(prefix: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) =>
      `${prefix}${issue.path.length > 0 ? `"${issue.path.join('.')}" ` : ''}${issue.message}`
  );
}

/**
 * Parse one model reply into steps, DIAGNOSING instead of shrugging: every
 * way the reply can be unusable produces a concrete, quotable problem
 * ("steps[3] "instruction" is required…", "step 2 uses {{tool:x}} which is
 * not in the list") — because those strings go back to the model verbatim
 * as the retry feedback, and "unusable answer" teaches it nothing.
 */
/** Shared mutable state for one reply's recursive parse. */
interface ParseState {
  problems: string[];
  softProblems: string[];
  knownVars: Set<string>;
  usedSaveAs: Set<string>;
  validTools: Set<string>;
  outcomesByTool: Map<string, Set<string>>;
  /** sN (pre-order over the CURRENT tree) → the existing node. */
  originByRef: Map<string, AgentStepNode>;
}

function originOf(state: ParseState, from: string | null | undefined): AgentStepNode | undefined {
  if (typeof from !== 'string') return undefined;
  return state.originByRef.get(from.trim());
}

function parseDraftReply(
  raw: string,
  currentSteps: AgentStepNode[],
  validTools: Set<string>,
  outcomesByTool: Map<string, Set<string>>,
  seedVars: Set<string>
): { ok: true; draft: DraftedAgent; softProblems: string[] } | { ok: false; problems: string[] } {
  const cleaned = raw.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, problems: ['The reply contained no JSON object at all.'] };
  }

  let json: unknown;
  try {
    json = JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    return {
      ok: false,
      problems: [
        `The JSON could not be parsed: ${error instanceof Error ? error.message : 'syntax error'}.`,
      ],
    };
  }

  const envelope = REPLY_ENVELOPE.safeParse(json);
  if (!envelope.success) {
    return { ok: false, problems: zodProblems('The reply object: ', envelope.error) };
  }
  const parsed = envelope.data;

  const state: ParseState = {
    problems: [],
    softProblems: [],
    knownVars: new Set(seedVars),
    usedSaveAs: new Set<string>(),
    validTools,
    outcomesByTool,
    originByRef: new Map(
      walkSteps(currentSteps).map(({ node, ordinal }) => [`s${ordinal + 1}`, node])
    ),
  };

  const steps = parseNodeList(parsed.steps, 'Step', state, 1);
  const { problems, softProblems } = state;

  if (steps.length === 0) {
    return {
      ok: false,
      problems: problems.length > 0 ? problems : ['No step had a usable instruction.'],
    };
  }
  // Some steps parsed, some did not: usable, but the broken ones are worth
  // a corrective round trip.
  softProblems.push(...problems);

  // A model that echoes the same origin twice would duplicate ids; keep the
  // first claim, regenerate the rest — across the whole tree, path ids
  // included.
  const seenIds = new Set<string>();
  const claimId = (id: string): string => {
    const fresh = seenIds.has(id) ? randomUUID() : id;
    seenIds.add(fresh);
    return fresh;
  };
  const dedupe = (nodes: AgentStepNode[]): void => {
    for (const node of nodes) {
      node.id = claimId(node.id);
      if (isBranchStep(node)) {
        for (const path of node.paths) {
          path.id = claimId(path.id);
          dedupe(path.steps);
        }
      }
    }
  };
  dedupe(steps);

  return {
    ok: true,
    draft: {
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 200) : '',
      steps,
    },
    softProblems,
  };
}

/** Parse a wire steps array — branch entries recurse, broken ones diagnose. */
function parseNodeList(
  entries: unknown[],
  labelPrefix: string,
  state: ParseState,
  depth: number
): AgentStepNode[] {
  const nodes: AgentStepNode[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `${labelPrefix} ${index + 1}`;
    if (isBranchWire(entry)) {
      const parsedBranch = parseBranchEntry(entry, label, state, depth);
      if (parsedBranch) nodes.push(parsedBranch);
      continue;
    }
    const checked = STEP_SHAPE.safeParse(entry);
    if (!checked.success) {
      state.problems.push(...zodProblems(`${label}: `, checked.error));
      continue;
    }
    nodes.push(parseActionEntry(checked.data, label, state));
  }
  return nodes;
}

function parseBranchEntry(
  entry: unknown,
  label: string,
  state: ParseState,
  depth: number
): AgentStepNode | null {
  const checked = BRANCH_SHAPE.safeParse(entry);
  if (!checked.success) {
    state.problems.push(...zodProblems(`${label} (branch): `, checked.error));
    return null;
  }
  const wire = checked.data;

  if (depth >= MAX_BRANCH_DEPTH) {
    state.softProblems.push(
      `${label} nests a branch deeper than one level — restructure so branches sit at most one inside another.`
    );
    return null;
  }
  if (/\{\{tool:/.test(wire.condition)) {
    state.softProblems.push(
      `${label} puts a {{tool:...}} token in a branch condition — do that work in a step before the branch and save the result; the tool token was dropped.`
    );
  }
  for (const match of wire.condition.matchAll(TOKEN_PATTERN)) {
    const [, kind, rawName] = match;
    const name = rawName.trim();
    if (kind === 'var' && !state.knownVars.has(name)) {
      state.softProblems.push(
        name.startsWith('trigger.')
          ? unknownTriggerVarProblem(`${label} (condition)`, name, state.knownVars)
          : `${label} references {{var:${name}}} in its condition, which no earlier step saves and no trigger provides.`
      );
    }
  }
  // No tool chips in a condition ever — drop even valid ones.
  const condition = segmentsOf(wire.condition, new Set<string>(), state.knownVars);

  const origin = originOf(state, wire.from);
  const branchOrigin = origin && isBranchStep(origin) ? origin : undefined;

  const path = (
    pathIndex: 0 | 1,
    labelText: string | undefined,
    fallback: string,
    steps: unknown[]
  ): BranchPath => ({
    id: branchOrigin?.paths[pathIndex].id ?? randomUUID(),
    name: (labelText ?? '').trim().slice(0, 80) || fallback,
    steps: parseNodeList(steps, `${label}.${pathIndex === 0 ? 'if' : 'else'}`, state, depth + 1),
  });

  return {
    id: branchOrigin?.id ?? randomUUID(),
    kind: 'branch',
    name: wire.name.slice(0, 80),
    condition,
    paths: [
      path(0, wire.ifLabel, 'If so', wire.ifSteps),
      path(1, wire.elseLabel, 'Otherwise', wire.elseSteps),
    ],
    maxAttempts: branchOrigin?.maxAttempts ?? 2,
  };
}

function parseActionEntry(
  step: z.infer<typeof STEP_SHAPE>,
  label: string,
  state: ParseState
): ActionStep {
  const { softProblems, knownVars, usedSaveAs, validTools, outcomesByTool } = state;

  // Unknown chips degrade to plain text, but they are also the retry
  // feedback that matters most: an invented tool name means the step
  // loses its skill entirely.
  for (const match of step.instruction.matchAll(TOKEN_PATTERN)) {
    const [, kind, rawName] = match;
    const name = rawName.trim();
    if (kind === 'tool' && !validTools.has(name)) {
      softProblems.push(
        `${label} uses {{tool:${name}}}, which is not in the available tools list — pick a tool from the list or make it a reasoning step.`
      );
    } else if (kind === 'var' && !knownVars.has(name)) {
      softProblems.push(
        name.startsWith('trigger.')
          ? unknownTriggerVarProblem(label, name, knownVars)
          : `${label} references {{var:${name}}}, which no earlier step saves and no trigger provides.`
      );
    }
  }
  if (
    typeof step.tool === 'string' &&
    step.tool &&
    !step.instruction.includes(`{{tool:${step.tool}}}`)
  ) {
    softProblems.push(
      `${label} sets "tool": "${step.tool}" but its instruction has no matching {{tool:${step.tool}}} token.`
    );
  }

  const segments = segmentsOf(step.instruction, validTools, knownVars);
  const tool = segments.find(
    (segment): segment is Extract<InstructionSegment, { t: 'tool' }> => segment.t === 'tool'
  );

  // "from": sN → the existing step this one is based on. Its identity,
  // attempt budget, and — when the tool didn't change — failure handling
  // survive the revision; the model only authors words and chips.
  const foundOrigin = originOf(state, step.from);
  const origin = foundOrigin && !isBranchStep(foundOrigin) ? foundOrigin : undefined;
  const sameTool = origin !== undefined && origin.tool === (tool?.name ?? null);

  let saveAs =
    typeof step.saveAs === 'string' && step.saveAs.trim() ? step.saveAs.trim() : origin?.saveAs;
  if (saveAs) {
    // Names that would bounce at save are coerced into shape here, with the
    // rule fed back so the corrective round trip learns it.
    const sanitized = sanitizeSaveAs(saveAs);
    if (sanitized !== saveAs) {
      softProblems.push(
        `${label} names its result "${saveAs}", which is not a usable name — start with a letter, then letters, numbers, spaces, ".", "-" or "_" (64 characters max).` +
          (sanitized ? ` It was renamed to "${sanitized}".` : ' The name was dropped.')
      );
      saveAs = sanitized || origin?.saveAs;
    }
  }
  if (saveAs) {
    // Result names must be unique across steps (the validator enforces
    // it at save); a duplicate is renamed so the draft stays usable and
    // the model is told what it did wrong.
    if (usedSaveAs.has(saveAs.toLowerCase())) {
      softProblems.push(
        `${label} reuses the result name "${saveAs}" — every saveAs must be unique across steps.`
      );
      let suffix = 2;
      let candidate = `${saveAs} ${suffix}`;
      while (usedSaveAs.has(candidate.toLowerCase())) {
        suffix += 1;
        candidate = `${saveAs} ${suffix}`;
      }
      saveAs = candidate.slice(0, 64);
    }
    usedSaveAs.add(saveAs.toLowerCase());
    knownVars.add(saveAs); // later steps may reference it
  }

  // Model-authored failure handling, checked against the tool's REAL
  // outcome codes so the validator never bounces what drafting produced.
  const authoredHandling: FailureHandling[] = [];
  if (step.failures && step.failures.length > 0) {
    if (!tool) {
      softProblems.push(
        `${label} has "failures" but no tool — failure handling belongs to tool steps.`
      );
    } else {
      const validCodes = outcomesByTool.get(tool.name) ?? new Set(['other']);
      const seenCodes = new Set<string>();
      for (const failure of step.failures) {
        if (seenCodes.has(failure.outcome)) continue;
        if (!validCodes.has(failure.outcome)) {
          softProblems.push(
            `${label} handles "${failure.outcome}", which is not a failure code of ` +
              `${tool.name} — its codes are: ${[...validCodes].join(', ')}.`
          );
          continue;
        }
        seenCodes.add(failure.outcome);
        const guidanceText = typeof failure.guidance === 'string' ? failure.guidance.trim() : '';
        if (failure.action === 'retry' && !guidanceText) {
          softProblems.push(
            `${label} retries on "${failure.outcome}" without guidance — guidance is ` +
              'required for retry, so it was changed to stop.'
          );
          authoredHandling.push({ outcome: failure.outcome, action: 'exit' });
          continue;
        }
        authoredHandling.push(
          failure.action === 'retry'
            ? {
                outcome: failure.outcome,
                action: 'retry',
                guidance: segmentsOf(guidanceText, validTools, knownVars, true),
              }
            : failure.action === 'stop-quiet'
              ? { outcome: failure.outcome, action: 'stop-quiet' }
              : { outcome: failure.outcome, action: 'exit' }
        );
      }
    }
  }

  return {
    id: origin?.id ?? randomUUID(),
    name: typeof step.name === 'string' ? step.name.slice(0, 80) : (origin?.name ?? ''),
    instruction: segments,
    tool: tool?.name ?? null,
    maxAttempts: step.tries ?? origin?.maxAttempts ?? 5,
    // The model's explicit handling wins; absent that, a revision keeps
    // the origin's (failure conditions belong to a tool — a changed tool
    // starts clean).
    failureHandling:
      step.failures !== undefined ? authoredHandling : sameTool ? origin.failureHandling : [],
    ...(saveAs ? { saveAs } : {}),
    ...(step.onSuccess && step.onSuccess !== 'continue'
      ? { onSuccess: step.onSuccess }
      : step.onSuccess === undefined && origin?.onSuccess
        ? { onSuccess: origin.onSuccess }
        : {}),
  };
}

export async function draftAgentFromProse(
  db: Kysely<DB>,
  tenantId: string,
  text: string,
  tools: ToolDescriptor[],
  options: {
    /** Present when revising: the builder's CURRENT (possibly unsaved) steps. */
    currentSteps?: AgentStepNode[];
    /** trigger.* variables the attached triggers provide (name + what it
     * is), so those chips verify and the prompt can explain them. */
    triggerVars?: TriggerVarInfo[];
  } = {}
): Promise<DraftedAgent | { error: string; detail?: string }> {
  const currentSteps = options.currentSteps ?? [];
  const triggerVars = options.triggerVars ?? [];
  const llmResult = await resolveAgentLlm(db, tenantId, null);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization yet.' };
  }
  const llm = llmResult.val;

  const validTools = new Set(tools.filter((tool) => !tool.appOnly).map((tool) => tool.name));
  const outcomesByTool = new Map(
    tools.map((tool) => [
      tool.name,
      new Set([...tool.outcomes.failures.map((failure) => failure.code), 'other']),
    ])
  );
  const seedVars = new Set([
    ...BUILTIN_VARIABLES.map((variable) => variable.name),
    ...triggerVars.map((variable) => variable.name),
    // Existing saveAs names stay referenceable even before their step is
    // re-emitted (the model may reorder).
    ...flattenActionSteps(currentSteps).flatMap((step) => (step.saveAs ? [step.saveAs] : [])),
  ]);

  // One corrective round trip: a failed parse (or a draft with invented
  // chips) goes back to the model WITH the concrete problems, because
  // "unusable answer — try again" teaches the human nothing and the model
  // less. The five-minute budget is shared across both calls.
  const deadline = Date.now() + DRAFT_TIMEOUT_MS;
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: promptOf(text.slice(0, MAX_PROSE_CHARS), tools, currentSteps, triggerVars),
        },
      ],
    },
  ];
  let lastProblems: string[] = [];
  // A first draft that parsed but had soft problems is kept: if the
  // corrective attempt REGRESSES (hard-fails or times out of budget), the
  // degraded-but-usable version beats an error.
  let usable: DraftedAgent | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break; // not enough budget for a useful call

    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = await Promise.race([
      llm.provider.complete({
        system:
          'You turn plain-language automation descriptions into structured steps. You reply with strict JSON.',
        messages,
        tools: [],
        // The model config's own ceiling when it is higher: reasoning
        // deployments spend completion tokens on thinking first, and 4096
        // can be ALL reasoning with no JSON left.
        maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
        // Just under the outer race so the HTTP call, not the race, decides.
        timeoutMs: Math.max(10_000, remaining - 5_000),
      }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (completion === 'timeout')
      return {
        error:
          'The model took over five minutes and was cut off — try again, or try a shorter description.',
      };
    if (!completion.ok) {
      logger.warn('prose draft failed: {kind} {message}', {
        component: 'agents/draft',
        tenantId,
        kind: completion.err.type,
        message: completion.err.message?.slice(0, 300) ?? '',
      });
      // The kind decides what the user can actually DO about it — a bare
      // "could not draft steps" hides whether to retry, wait, or go fix
      // the model configuration.
      const kind = completion.err.type;
      // The adapter's redacted request summary (field names and sizes,
      // never content) — shown to the person who clicked Draft, so "wrong
      // payload" is diagnosable from the builder itself.
      const detail = typeof completion.err.cause === 'string' ? completion.err.cause : undefined;
      if (kind === 'auth') {
        return {
          error:
            'The model rejected the organization’s API key — an admin can check it under Agent models.',
        };
      }
      if (kind === 'rate_limit' || kind === 'overloaded') {
        return { error: 'The model is rate-limiting right now — try again in a minute.' };
      }
      if (kind === 'timeout' || kind === 'network') {
        return {
          error: 'The model did not answer in time — try again, or try a shorter description.',
        };
      }
      if (kind === 'invalid_request') {
        return {
          error: `The model rejected the request${completion.err.message ? `: ${completion.err.message.slice(0, 500)}` : ''} — an admin can check the model configuration under Agent models.`,
          ...(detail ? { detail } : {}),
        };
      }
      return {
        error: `The model failed (${kind}) — try again or write the steps by hand.`,
        ...(detail ? { detail } : {}),
      };
    }

    const raw = completion.val.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const parsed = parseDraftReply(raw, currentSteps, validTools, outcomesByTool, seedVars);

    if (parsed.ok) {
      usable = parsed.draft;
      if (parsed.softProblems.length === 0 || attempt === 2) {
        // Good — or as good as one correction gets; chips that still don't
        // verify degrade to text for the user to re-chip deliberately.
        return parsed.draft;
      }
    }

    const problems = parsed.ok ? parsed.softProblems : parsed.problems;
    lastProblems = problems;
    logger.info('prose draft retry: {count} problem(s)', {
      component: 'agents/draft',
      tenantId,
      count: problems.length,
    });
    messages.push(
      { role: 'assistant', content: [{ type: 'text', text: raw.slice(0, 8_000) }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Your reply could not be used as-is. Problems:',
              ...problems.slice(0, 12).map((problem) => `- ${problem}`),
              '',
              'Reply again with ONLY the corrected JSON object, in exactly the structure ' +
                'described before. Fix every problem listed; keep everything that was already correct.',
            ].join('\n'),
          },
        ],
      }
    );
  }

  if (usable) return usable;

  logger.warn('prose draft unusable after retry: {problems}', {
    component: 'agents/draft',
    tenantId,
    problems: lastProblems.slice(0, 5).join(' | '),
  });
  return {
    error:
      lastProblems.length > 0
        ? `The model could not produce usable steps (${lastProblems[0]}) — try again or rephrase.`
        : 'The model gave an unusable answer — try again.',
  };
}
