/**
 * The step prompt: the model sees ONLY the current step.
 *
 * That is the design's token economy and its safety property in one — a
 * model that has never read step 7 cannot jump ahead to it, and a 10-step
 * agent costs one step's context per attempt, not ten. Everything the step
 * legitimately needs from elsewhere arrives as resolved variables (trigger
 * inputs, earlier steps' saved results), not as the plan.
 */

import { renderInstruction, type AgentStep } from '@renkei/agents';
import type { LlmMessage, LlmToolDef } from '@renkei/agent-llm';

export const FINISH_STEP_TOOL = 'finish_step';

export const FINISH_STEP_DEF: LlmToolDef = {
  name: FINISH_STEP_TOOL,
  description:
    'Declare the outcome of this step. Call exactly once, after the work is done or once it is clear it cannot be done.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['success', 'failure'] },
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
    },
    required: ['outcome', 'summary'],
  },
};

export const SYSTEM_PROMPT = [
  'You are executing one step of an automated workflow that a person drafted.',
  'Do only what this step says. You do not know the other steps, and you must not invent work beyond this one.',
  'You may call only the tools provided. When the step’s work is done, or it is clear it cannot be done, call finish_step exactly once with the outcome.',
  'Declare failure honestly: a tool error you could not work around is a failure, not a success.',
].join(' ');

export interface AttemptPromptInput {
  step: AgentStep;
  attempt: number;
  variables: Record<string, string>;
  /** Resolved corrective guidance, present on attempts >= 2 with a retry match. */
  guidanceText?: string;
  /** One-paragraph summary of the previous attempt's failure. */
  previousFailure?: string;
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
    ...(input.step.saveAs
      ? [
          `When you succeed, include saveValue in finish_step — it becomes "${input.step.saveAs}" for later use.`,
        ]
      : []),
    ...(variableLines ? [`Known information:\n${variableLines}`] : []),
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
