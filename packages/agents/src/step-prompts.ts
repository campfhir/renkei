/**
 * The step prompts — the EXACT text the engine sends the model at run
 * time, in the shared package so every other surface that claims to show
 * "what the model sees" (the agent page's markdown export, previews)
 * renders through THIS code and cannot drift. Moved from
 * apps/worker-agents/src/prompt.ts, which now re-exports it.
 *
 * The message/tool-def types here are structural twins of
 * @renkei/agent-llm's LlmMessage/LlmToolDef (text blocks only — prompts
 * are text) so this package does not depend on the LLM layer; assignment
 * into the provider contract is checked where the engine uses them.
 */

import { resolveOutcomes } from '@renkei/tool-outcomes';
import { renderInstruction } from './render';
import { attemptVariables } from './variables';
import type { ActionStep, AgentStep, BranchStep, UntilLoopStep } from './steps';

/** Structural twin of @renkei/agent-llm's text-only PromptMessage. */
export interface PromptMessage {
  role: 'user';
  content: { type: 'text'; text: string }[];
}

/** Structural twin of @renkei/agent-llm's PromptToolDef. */
export interface PromptToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const RESOLVE_TIME_TOOL = 'resolve_time';

/**
 * Deterministic date arithmetic, offered in every action step and FREE —
 * it does not touch the step's tool budget, and it is not the step's "one
 * tool" either.
 *
 * It exists because models are confidently wrong at this. "Yesterday at
 * 19:00 in America/Los_Angeles, as UTC" needs a calendar shift, a
 * wall-clock set and a DST-aware conversion, and a wrong answer is
 * indistinguishable from a right one until a search quietly covers the
 * wrong window. Charging for the call would push a model toward guessing
 * instead — which is the failure this is meant to remove.
 */
export const RESOLVE_TIME_DEF: PromptToolDef = {
  name: RESOLVE_TIME_TOOL,
  description:
    'Compute an exact timestamp instead of working one out yourself. Say which timezone, ' +
    'how far to move (amount + unit), and optionally the time of day; you get back the ' +
    'instant in UTC. Free: it never counts against your tool budget, so use it whenever a ' +
    'date or time matters — never hand-calculate one.',
  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          'IANA zone the times are expressed in, e.g. "America/Los_Angeles" or "UTC". ' +
          'Use the timezone the request is written in, not your own.',
      },
      amount: {
        type: 'number',
        description:
          'How far to move, signed: -1 with unit "day" is yesterday, 2 with "week" is a ' +
          'fortnight from now. Omit for "today"/"now".',
      },
      unit: {
        type: 'string',
        enum: ['minute', 'hour', 'day', 'week', 'month', 'year'],
        description:
          'The unit for amount. minute/hour are exact elapsed time; day and larger keep the ' +
          'same wall-clock time across daylight-saving changes.',
      },
      atTime: {
        type: 'string',
        description:
          'Time of day in the target zone, 24-hour "HH:MM" — e.g. "19:00" for 7pm. Applied ' +
          'after the shift.',
      },
      anchor: {
        type: 'string',
        description:
          'What to measure from: "now" (default) or an ISO 8601 instant such as a timestamp ' +
          'from an earlier step.',
      },
      startOf: {
        type: 'string',
        enum: ['hour', 'day', 'week', 'month'],
        description: 'Snap to the beginning of this unit. Ignored when atTime is given.',
      },
      endOf: {
        type: 'string',
        enum: ['hour', 'day', 'week', 'month'],
        description: 'Snap to the last minute of this unit. Ignored when atTime is given.',
      },
    },
    required: ['timezone'],
  },
};

export const FINISH_STEP_TOOL = 'finish_step';

export const FINISH_STEP_DEF: PromptToolDef = {
  name: FINISH_STEP_TOOL,
  description:
    'Declare the outcome of this step. Call exactly once, after the work is done or once it is clear it cannot be done.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['success', 'failure', 'skipped'],
        description:
          "'success' when the step's work is done; 'failure' when it could not be done; " +
          "'skipped' when the step determined the automation does not apply to this " +
          'input at all (out of scope, no valid target, already handled) — the WHOLE run ' +
          'ends there gracefully, as a non-failure, with summary saying why. An empty ' +
          "search result is never 'skipped' — that is an answer.",
      },
      code: {
        type: 'string',
        description:
          "On failure: the condition code that best matches what went wrong (e.g. 'not-found', 'no-permission', 'invalid-input', 'service-unavailable', 'other').",
      },
      summary: {
        type: 'string',
        description: 'One or two sentences on what happened, written for the agent owner.',
      },
      saveValue: {
        type: 'string',
        description:
          'If this step was asked to save its result, the value to save (an ID, a key, a short text). Omit otherwise.',
      },
      saveItems: {
        type: 'array',
        items: { type: 'string' },
        description:
          'When the step was asked to save a LIST — items a later part of the automation ' +
          'iterates one by one — the items, one string per entry (an id, a key, a short ' +
          'line each). At most 25. Use INSTEAD of cramming a list into saveValue.',
      },
      stop: {
        type: 'boolean',
        description:
          'On success only: true when the instruction says the WHOLE automation should end here ' +
          '("…and stop here") — later steps will not run. Omit otherwise.',
      },
      quiet: {
        type: 'boolean',
        description:
          'With stop: true when the instruction says to end silently / do nothing — no reply, ' +
          'no notification, no follow-up automations. Omit otherwise.',
      },
      remember: {
        type: 'string',
        description:
          'A short note (one sentence, include identifiers like message ids) worth carrying ' +
          'into FUTURE runs of this agent — e.g. "replied to message 123 about the outage". ' +
          'Future runs see it under "What you remember". Omit when nothing is worth keeping.',
      },
    },
    required: ['outcome', 'summary'],
  },
};

export const ASK_PERSON_TOOL = 'ask_person';

/**
 * Free, offered only when the agent's `canAskQuestions` is on: pause this
 * step and raise a card the owner answers, instead of guessing or failing.
 * Ends the current attempt (like finish_step) — the answer, or a timeout,
 * arrives on a FRESH attempt whose prompt states what was asked and what
 * came back, so no in-flight reasoning has to survive the wait. One form
 * per call is deliberate: several pending questions belong in one card
 * (paragraphs and groups exist for exactly that), not a loop of asks.
 */
export const ASK_PERSON_DEF: PromptToolDef = {
  name: ASK_PERSON_TOOL,
  description:
    'Pause this step and ask the owner something, instead of guessing or failing for lack of ' +
    'it. Ends this attempt; the answer (or a timeout) starts a fresh one that sees both what ' +
    'was asked and what came back. Put every question you have right now into ONE call — ' +
    'group and paragraph entries in form let several questions share one readable card.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Plain prose: what you need and why, shown above any form fields.',
      },
      form: {
        type: 'array',
        description:
          'Optional structure beyond the open question in message — at most 40 entries total ' +
          "(a group's members count toward that). Each entry is one of: " +
          '{kind:"field", name, label, type: "text"|"longtext"|"number"|"choice"|"multi"|"date", ' +
          'required, options?, min?, max?, help?, key?} — an answerable control, "key" being the ' +
          "destination's own field id (e.g. a Jira custom field) when the answer is headed " +
          'somewhere specific; {kind:"paragraph", text} — context with nothing to answer; or ' +
          '{kind:"group", label, nodes} — one level of fields/paragraphs clustered under a ' +
          'heading (groups do not nest). A two-option "choice" reads as yes/no buttons.',
        items: { type: 'object' },
      },
      timeoutHours: {
        type: 'number',
        description:
          'How long to wait for an answer before treating it as unanswered. Default 96 (4 days).',
      },
    },
    required: ['message'],
  },
};

export const SYSTEM_PROMPT = [
  'You are executing one step of an automated workflow that a person drafted.',
  'Do only what this step says. You do not know the other steps, and you must not invent work beyond this one.',
  'You may call only the tools provided. When the step’s work is done, or it is clear it cannot be done, call finish_step exactly once with the outcome.',
  'Aim to finish: when what you have satisfies the step’s intent, declare success rather than double-checking with more calls.',
  'When the instruction says the whole automation should end at this step ("…and stop here"), set stop: true on finish_step; when it says to end silently or do nothing, also set quiet: true.',
  'When the automation turns out not to apply to this input at all — out of scope, no valid target, already handled — that is not a failure: declare outcome "skipped" with a summary saying why, and the automation ends there gracefully.',
  'An empty result is NOT a skip: a search or lookup that runs cleanly but finds nothing has produced an answer — declare success and save that nothing was found (or, when the step lists a failure code for it, declare failure with that code so the configured handling decides). Skip only when the triggering input itself is out of scope for the whole automation.',
  'Declare failure honestly: a tool error you could not work around, or a result that clearly does not match the step’s intent, is a failure, not a success.',
  'You may be shown "What you remember" (notes from this agent’s earlier runs) and "Your knowledge notes". Use them to avoid repeating work already done — e.g. do not act again on a message an earlier run already handled — and record anything future runs must know via finish_step’s remember field.',
].join(' ');

/**
 * SYSTEM_PROMPT plus the guardrails framing — appended ONLY when the agent
 * has guardrails, so every agent without them keeps a byte-identical
 * system prompt (the same freeze discipline the branch prompts follow).
 */
export function systemPromptWith(guardrailsText?: string): string {
  if (!guardrailsText) return SYSTEM_PROMPT;
  return (
    SYSTEM_PROMPT +
    ' The owner’s standing guardrails are shown with the step. They are binding: where they and the instruction conflict, the guardrails win.'
  );
}

/** The guardrails block every prompt builder renders — in full, never clipped. */
function guardrailsBlock(text: string): string {
  return `Standing guardrails from this agent’s owner (binding — where they and the task conflict, the guardrails win):\n${text}`;
}

export const CHOOSE_PATH_TOOL = 'choose_path';

/**
 * The two-path def, FROZEN byte-for-byte: every v2 agent's branch prompt
 * must not drift. N-way branches get their own def via buildChoosePathDef.
 */
export const CHOOSE_PATH_DEF: PromptToolDef = {
  name: CHOOSE_PATH_TOOL,
  description: 'Decide which path the automation takes. Call exactly once.',
  inputSchema: {
    type: 'object',
    properties: {
      choice: {
        type: 'string',
        enum: ['yes', 'no'],
        description: 'yes → the condition holds; no → it does not.',
      },
      reason: {
        type: 'string',
        description: 'One or two sentences on why, written for the agent owner.',
      },
    },
    required: ['choice', 'reason'],
  },
};

/** The branch's choose_path def: the frozen yes/no pair, or a numbered route enum. */
export function buildChoosePathDef(branch: BranchStep): PromptToolDef {
  if (branch.paths.length === 2) return CHOOSE_PATH_DEF;
  const listing = branch.paths
    .map((path, index) => `${index + 1} = ${path.name || `path ${index + 1}`}`)
    .join('; ');
  return {
    name: CHOOSE_PATH_TOOL,
    description: 'Decide which path the automation takes. Call exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: branch.paths.map((_, index) => String(index + 1)),
          description: `${listing}. Choose ${branch.paths.length} when none of the others clearly applies.`,
        },
        reason: {
          type: 'string',
          description: 'One or two sentences on why, written for the agent owner.',
        },
      },
      required: ['choice', 'reason'],
    },
  };
}

/**
 * The condition evaluator's frame: judgment only, no tools, no invention.
 * Mirrors finish_step's forced-call pattern — one declared verdict.
 * FROZEN for two-path branches; routers get ROUTER_SYSTEM_PROMPT.
 */
export const BRANCH_SYSTEM_PROMPT = [
  'You are deciding one yes/no branch of an automated workflow that a person drafted.',
  'Judge only from the information given — you have no tools and must not invent facts.',
  'When the information given does not settle the condition, choose the answer the condition’s wording treats as the default ("no" for "did anything happen?" style conditions).',
  'Call choose_path exactly once.',
].join(' ');

/** The N-way sibling of BRANCH_SYSTEM_PROMPT. */
export const ROUTER_SYSTEM_PROMPT = [
  'You are routing one decision of an automated workflow that a person drafted, between several labeled paths.',
  'Judge only from the information given — you have no tools and must not invent facts.',
  'Pick the single path that best matches. When the information given does not clearly match any path, pick the LAST one — it is the fallback.',
  'Call choose_path exactly once.',
].join(' ');

export const LOOP_DECISION_TOOL = 'loop_decision';

export const LOOP_DECISION_DEF: PromptToolDef = {
  name: LOOP_DECISION_TOOL,
  description: 'Decide whether the loop is finished. Call exactly once.',
  inputSchema: {
    type: 'object',
    properties: {
      choice: {
        type: 'string',
        enum: ['finished', 'continue'],
        description:
          "'finished' → the stop condition holds and the automation moves on; " +
          "'continue' → it does not hold yet and the loop runs another round.",
      },
      reason: {
        type: 'string',
        description: 'One or two sentences on why, written for the agent owner.',
      },
    },
    required: ['choice', 'reason'],
  },
};

/** The until-loop evaluator's frame — judgment only, like a branch. */
export const LOOP_SYSTEM_PROMPT = [
  'You are deciding whether a repeating part of an automated workflow is finished.',
  'The loop’s body has just run; judge only from the information given — you have no tools and must not invent facts.',
  'When the information given does not settle it, choose "continue" — the loop has a hard round limit either way.',
  'Call loop_decision exactly once.',
].join(' ');

export interface LoopPromptInput {
  loop: UntilLoopStep;
  iteration: number;
  variables: Record<string, string>;
  attempt: number;
  /** One-paragraph summary of the previous evaluation attempt's failure. */
  previousFailure?: string;
  /** Rendered agent memory (summary + recent entries), already bounded. */
  memoryText?: string;
  /** Rendered agent knowledge notes, already bounded. */
  knowledgeText?: string;
  /** The agent's standing guardrails — injected in full, never clipped. */
  guardrailsText?: string;
}

export function buildLoopConditionMessages(input: LoopPromptInput): {
  messages: PromptMessage[];
  unbound: string[];
} {
  const rendered = renderInstruction(input.loop.condition, input.variables);
  const variableLines = Object.entries(input.variables)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');

  const parts = [
    `Loop: ${input.loop.name}`,
    ...(input.guardrailsText ? [guardrailsBlock(input.guardrailsText)] : []),
    `Round ${input.iteration} of at most ${input.loop.maxIterations} has just finished.`,
    `Stop condition to decide: ${rendered.text}`,
    'If it HOLDS (choice: "finished") the automation continues after the loop. If it does NOT hold yet (choice: "continue") the loop runs another round.',
    ...(variableLines ? [`Known information:\n${variableLines}`] : []),
    ...(input.memoryText
      ? [`What you remember (notes from this agent’s earlier runs):\n${input.memoryText}`]
      : []),
    ...(input.knowledgeText
      ? [
          'Your knowledge notes — an INDEX of what this agent keeps, newest first. Short notes are shown whole; longer ones show only their title and id, and agent_knowledge_list returns the full text when one looks relevant. Do not assume a note says what its title suggests:\n' +
            input.knowledgeText,
        ]
      : []),
    ...(input.attempt > 1
      ? [
          `This is attempt ${input.attempt} of ${input.loop.maxAttempts}.`,
          ...(input.previousFailure ? [`Previous attempt: ${input.previousFailure}`] : []),
        ]
      : []),
  ];

  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }],
    unbound: rendered.unbound,
  };
}

export interface BranchPromptInput {
  branch: BranchStep;
  variables: Record<string, string>;
  attempt: number;
  /** One-paragraph summary of the previous evaluation attempt's failure. */
  previousFailure?: string;
  /** Rendered agent memory (summary + recent entries), already bounded. */
  memoryText?: string;
  /** Rendered agent knowledge notes, already bounded. */
  knowledgeText?: string;
  /** The agent's standing guardrails — injected in full, never clipped. */
  guardrailsText?: string;
}

export function buildBranchMessages(input: BranchPromptInput): {
  messages: PromptMessage[];
  unbound: string[];
} {
  const rendered = renderInstruction(input.branch.condition, input.variables);
  const variableLines = Object.entries(input.variables)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');

  // Two-path prose is FROZEN (v2 agents must not drift); routers list
  // their numbered choices with the last-path fallback stated.
  const routing =
    input.branch.paths.length === 2
      ? `If YES (choice: "yes") the automation takes the path "${input.branch.paths[0].name}". ` +
        `If NO (choice: "no") it takes the path "${input.branch.paths[1].name}".`
      : [
          'The paths, by number:',
          ...input.branch.paths.map(
            (path, index) => `${index + 1}. "${path.name || `path ${index + 1}`}"`
          ),
          `Pick the single best match; when nothing clearly applies, pick ${input.branch.paths.length} — it is the fallback.`,
        ].join('\n');

  const parts = [
    `Branch: ${input.branch.name}`,
    ...(input.guardrailsText ? [guardrailsBlock(input.guardrailsText)] : []),
    `Condition to decide: ${rendered.text}`,
    routing,
    ...(variableLines ? [`Known information:\n${variableLines}`] : []),
    ...(input.memoryText
      ? [`What you remember (notes from this agent’s earlier runs):\n${input.memoryText}`]
      : []),
    ...(input.knowledgeText
      ? [
          'Your knowledge notes — an INDEX of what this agent keeps, newest first. Short notes are shown whole; longer ones show only their title and id, and agent_knowledge_list returns the full text when one looks relevant. Do not assume a note says what its title suggests:\n' +
            input.knowledgeText,
        ]
      : []),
    ...(input.attempt > 1
      ? [
          `This is attempt ${input.attempt} of ${input.branch.maxAttempts}.`,
          ...(input.previousFailure ? [`Previous attempt: ${input.previousFailure}`] : []),
        ]
      : []),
  ];

  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }],
    unbound: rendered.unbound,
  };
}

export interface AttemptPromptInput {
  step: AgentStep;
  attempt: number;
  variables: Record<string, string>;
  /**
   * How many tool calls this attempt may spend (finish_step is free). Stated
   * to the model so it can ration — a budget it cannot see is a trapdoor,
   * not a guard: the model explores as if calls were free and the attempt
   * dies mid-thought.
   */
  toolBudget: number;
  /** Resolved corrective guidance, present on attempts >= 2 with a retry match. */
  guidanceText?: string;
  /** One-paragraph summary of the previous attempt's failure. */
  previousFailure?: string;
  /** Rendered agent memory (summary + recent entries), already bounded. */
  memoryText?: string;
  /** Rendered agent knowledge notes, already bounded. */
  knowledgeText?: string;
  /** The agent's standing guardrails — injected in full, never clipped. */
  guardrailsText?: string;
  /** True when this step's saveAs is a loop's items source — nudge saveItems. */
  savesItemsForLoop?: boolean;
  /**
   * The failure codes this step's handling can route, rendered as prose by
   * the engine — so a declared failure lands on the code the author
   * planned for instead of an unroutable 'other'. Absent when the step
   * handles nothing.
   */
  outcomeGuide?: string;
}

export function buildAttemptMessages(input: AttemptPromptInput): {
  messages: PromptMessage[];
  unbound: string[];
} {
  // The attempt chips are bound HERE rather than by the caller: this is the
  // first place that knows both which try this is and what the step's
  // ceiling is. They are deliberately kept out of `variableLines` below —
  // the prompt already states the attempt in its own words on a retry, and
  // repeating it as "known information" on every first attempt is noise.
  // Attempt bindings go FIRST so a caller that supplies these names wins.
  // export-markdown renders every var chip as a {{name}} placeholder — it is
  // describing an agent to a person, not running one — and binding real
  // numbers over the top would print "try 1 of 3" as if that were the
  // instruction's literal text.
  const variablesWithAttempt = {
    ...attemptVariables(input.attempt, input.step.maxAttempts),
    ...input.variables,
  };
  const rendered = renderInstruction(input.step.instruction, variablesWithAttempt);

  const variableLines = Object.entries(input.variables)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');

  const parts = [
    `Step: ${input.step.name}`,
    ...(input.guardrailsText ? [guardrailsBlock(input.guardrailsText)] : []),
    `Instruction: ${rendered.text}`,
    `Tool budget: at most ${input.toolBudget} tool call(s) this attempt (finish_step and ` +
      `${RESOLVE_TIME_TOOL} are free). ` +
      'Spend them deliberately — one well-chosen call beats several exploratory ones. When the ' +
      'budget runs out you will be asked to declare the outcome from what you have already seen.',
    `Dates: never work out a timestamp in your head. Call ${RESOLVE_TIME_TOOL} — it is free, it ` +
      'is exact about timezones and daylight saving, and a date you calculated yourself is the ' +
      'single most likely thing in this step to be quietly wrong.',
    ...(input.step.saveAs
      ? [
          input.savesItemsForLoop
            ? `When you succeed, include saveItems in finish_step (one string per item) — the list becomes "${input.step.saveAs}", and a later part of the automation handles the items one by one.`
            : `When you succeed, include saveValue in finish_step — it becomes "${input.step.saveAs}" for later use.`,
        ]
      : []),
    ...(input.outcomeGuide ? [input.outcomeGuide] : []),
    ...(variableLines ? [`Known information:\n${variableLines}`] : []),
    ...(input.memoryText
      ? [
          'What you remember (notes from this agent’s earlier runs, oldest first — check it ' +
            `before acting on something an earlier run may already have handled):\n${input.memoryText}`,
        ]
      : []),
    ...(input.knowledgeText
      ? [
          'Your knowledge notes — an INDEX of what this agent keeps, newest first. Short notes are shown whole; longer ones show only their title and id, and agent_knowledge_list returns the full text when one looks relevant. Do not assume a note says what its title suggests:\n' +
            input.knowledgeText,
        ]
      : []),
    ...(input.attempt > 1
      ? [
          `This is attempt ${input.attempt} of ${input.step.maxAttempts}.`,
          ...(input.previousFailure ? [`Previous attempt: ${input.previousFailure}`] : []),
          ...(input.guidanceText ? [`Extra guidance for this retry: ${input.guidanceText}`] : []),
        ]
      : []),
  ];

  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }],
    unbound: rendered.unbound,
  };
}

/**
 * Tool-call budgets per attempt: the normal allowance, and the laxer
 * corrective one for retry attempts (fixing a failure may take extra
 * lookups). Stated in the prompt (see buildAttemptMessages) — a budget the
 * model cannot see is a trapdoor, not a guard.
 */
export const NORMAL_TOOL_CAP = 3;
export const CORRECTIVE_TOOL_CAP = 10;

/**
 * The conditions this step's author planned for, as a prompt paragraph.
 *
 * Injected on EVERY attempt so a declared condition lands on a code the
 * handling can route instead of an unroutable 'other'. Three kinds of
 * entry, all listed:
 *
 *  - enumerated codes wear the outcome catalog's label (`resolveOutcomes`
 *    is pure data; the kind argument only shapes the unused success label);
 *  - CUSTOM codes wear the author's own "applies when" description — the
 *    only thing that steers classification into an invented code, so it is
 *    load-bearing prose;
 *  - non-retry entries carry the author's note (advisory prose), rendered
 *    with the step's variables. Retry guidance is deliberately NOT shown
 *    here — it appears as "Extra guidance" on attempts ≥ 2, where its tool
 *    chips are also offered.
 *
 * And the rule that makes reasoned outcomes work at all: a call that
 * SUCCEEDED technically can still match a planned condition ("results
 * found, but none close enough") — the model judges that over the result
 * and declares the condition's code, because the tool cannot.
 */
export function outcomeGuideFor(
  step: ActionStep,
  vars: Record<string, string>
): string | undefined {
  if (step.tool === null || step.failureHandling.length === 0) return undefined;
  const labelOf = new Map(
    resolveOutcomes(step.tool, 'read').failures.map((failure) => [failure.code, failure.label])
  );
  const listed = step.failureHandling
    .map((handling) => {
      const label = labelOf.get(handling.outcome);
      const described =
        handling.when !== undefined
          ? `"${handling.outcome}" (applies when: ${handling.when})`
          : label
            ? `"${handling.outcome}" (${label.toLowerCase()})`
            : `"${handling.outcome}"`;
      const note =
        handling.action !== 'retry' && handling.guidance && handling.guidance.length > 0
          ? ` — the author notes: ${renderInstruction(handling.guidance, vars).text}`
          : '';
      return `${described}${note}`;
    })
    .join('; ');
  const handled = step.failureHandling.map((handling) => handling.outcome);
  const parts = [
    `Conditions this step plans for: ${listed}. When the outcome matches one, declare it with ` +
      `that exact code; anything else falls under "other". These conditions are judged by YOU ` +
      `over the result — a call that technically succeeded whose result matches one of them IS ` +
      `that condition (declare failure with its code so the planned handling routes it), and ` +
      `the author's notes above tell you what they meant by planning for it.`,
  ];
  if (handled.includes('no-results')) {
    parts.push(
      'A search or lookup that runs cleanly but matches nothing IS that "no-results" failure — ' +
        'declare it as such (never success with an empty answer, never "skipped") so the ' +
        'configured handling decides what happens next. If you have tries left you will be ' +
        'asked to search again differently.'
    );
  }
  return parts.join(' ');
}
