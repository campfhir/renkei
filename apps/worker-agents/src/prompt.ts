/**
 * The step prompt: the model sees ONLY the current step.
 *
 * That is the design's token economy and its safety property in one — a
 * model that has never read step 7 cannot jump ahead to it, and a 10-step
 * agent costs one step's context per attempt, not ten. Everything the step
 * legitimately needs from elsewhere arrives as resolved variables (trigger
 * inputs, earlier steps' saved results), not as the plan.
 */

import { renderInstruction, type AgentStep, type BranchStep } from '@renkei/agents';
import type { LlmMessage, LlmToolDef } from '@renkei/agent-llm';

export const FINISH_STEP_TOOL = 'finish_step';

export const FINISH_STEP_DEF: LlmToolDef = {
  name: FINISH_STEP_TOOL,
  description:
    'Declare the outcome of this step. Call exactly once, after the work is done or once it is clear it cannot be done.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['success', 'failure', 'nothing-to-do'],
        description:
          "'success' when the step's work is done; 'failure' when it could not be done; " +
          "'nothing-to-do' when the step determined the automation does not apply to this " +
          'input at all (out of scope, no valid target, already handled) — the WHOLE run ' +
          'ends there gracefully, as a non-failure, with summary saying why.',
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

export const SYSTEM_PROMPT = [
  'You are executing one step of an automated workflow that a person drafted.',
  'Do only what this step says. You do not know the other steps, and you must not invent work beyond this one.',
  'You may call only the tools provided. When the step’s work is done, or it is clear it cannot be done, call finish_step exactly once with the outcome.',
  'Aim to finish: when what you have satisfies the step’s intent, declare success rather than double-checking with more calls.',
  'When the instruction says the whole automation should end at this step ("…and stop here"), set stop: true on finish_step; when it says to end silently or do nothing, also set quiet: true.',
  'When the work turns out not to apply to this input at all — out of scope, no valid target, nothing left to do — that is not a failure: declare outcome "nothing-to-do" with a summary saying why, and the automation ends there gracefully.',
  'Declare failure honestly: a tool error you could not work around, or a result that clearly does not match the step’s intent, is a failure, not a success.',
  'You may be shown "What you remember" (notes from this agent’s earlier runs) and "Your knowledge notes". Use them to avoid repeating work already done — e.g. do not act again on a message an earlier run already handled — and record anything future runs must know via finish_step’s remember field.',
].join(' ');

export const CHOOSE_PATH_TOOL = 'choose_path';

export const CHOOSE_PATH_DEF: LlmToolDef = {
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

/**
 * The condition evaluator's frame: judgment only, no tools, no invention.
 * Mirrors finish_step's forced-call pattern — one declared verdict.
 */
export const BRANCH_SYSTEM_PROMPT = [
  'You are deciding one yes/no branch of an automated workflow that a person drafted.',
  'Judge only from the information given — you have no tools and must not invent facts.',
  'When the information given does not settle the condition, choose the answer the condition’s wording treats as the default ("no" for "did anything happen?" style conditions).',
  'Call choose_path exactly once.',
].join(' ');

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
}

export function buildBranchMessages(input: BranchPromptInput): {
  messages: LlmMessage[];
  unbound: string[];
} {
  const rendered = renderInstruction(input.branch.condition, input.variables);
  const variableLines = Object.entries(input.variables)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');

  const parts = [
    `Branch: ${input.branch.name}`,
    `Condition to decide: ${rendered.text}`,
    `If YES (choice: "yes") the automation takes the path "${input.branch.paths[0].name}". ` +
      `If NO (choice: "no") it takes the path "${input.branch.paths[1].name}".`,
    ...(variableLines ? [`Known information:\n${variableLines}`] : []),
    ...(input.memoryText
      ? [`What you remember (notes from this agent’s earlier runs):\n${input.memoryText}`]
      : []),
    ...(input.knowledgeText
      ? [`Your knowledge notes (reference material this agent keeps):\n${input.knowledgeText}`]
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
}

export function buildAttemptMessages(input: AttemptPromptInput): {
  messages: LlmMessage[];
  unbound: string[];
} {
  const rendered = renderInstruction(input.step.instruction, input.variables);

  const variableLines = Object.entries(input.variables)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');

  const parts = [
    `Step: ${input.step.name}`,
    `Instruction: ${rendered.text}`,
    `Tool budget: at most ${input.toolBudget} tool call(s) this attempt (finish_step is free). ` +
      'Spend them deliberately — one well-chosen call beats several exploratory ones. When the ' +
      'budget runs out you will be asked to declare the outcome from what you have already seen.',
    ...(input.step.saveAs
      ? [
          `When you succeed, include saveValue in finish_step — it becomes "${input.step.saveAs}" for later use.`,
        ]
      : []),
    ...(variableLines ? [`Known information:\n${variableLines}`] : []),
    ...(input.memoryText
      ? [
          'What you remember (notes from this agent’s earlier runs, oldest first — check it ' +
            `before acting on something an earlier run may already have handled):\n${input.memoryText}`,
        ]
      : []),
    ...(input.knowledgeText
      ? [`Your knowledge notes (reference material this agent keeps):\n${input.knowledgeText}`]
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
