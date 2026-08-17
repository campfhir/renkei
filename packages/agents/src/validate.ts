/**
 * The one validator, called from both sides of the wire.
 *
 * The builder calls it client-side for inline hints; the CRUD routes call
 * it server-side as the authority. One function, two callers — a rule that
 * existed only in the UI would be a rule that did not exist.
 *
 * It CLAMPS rather than rejects where the platform has a ceiling: a draft
 * asking for 99 attempts persists with 10, because the cap is the platform's
 * decision, not a negotiation with the client. `normalizeAgentDraft` is
 * therefore part of the contract: routes persist the normalized draft, not
 * the submitted one.
 *
 * Tool existence is checked against the SAVING USER's tool projection
 * (whatever list the caller passes — the web fetches it from the catalog).
 * Losing a tool later does not invalidate the saved agent; availability is
 * a runtime property owned by the gates, and the engine pre-flights it per
 * run.
 */

import {
  MAX_INSTRUCTION_CHARS,
  MAX_STEP_ATTEMPTS,
  MAX_STEPS,
  VARIABLE_NAME_PATTERN,
  toolSegments,
  varSegments,
  type AgentStep,
  type AgentStepsDoc,
  type InstructionSegment,
} from './steps';
import { BUILTIN_VARIABLES } from './variables';
import { validateTriggerDrafts, triggerVariableNames, type TriggerDraft } from './triggers';

/** The slice of the web catalog's ToolDescriptor validation needs. */
export interface ToolDescriptorLike {
  name: string;
  appOnly: boolean;
  outcomes: { failures: { code: string }[] };
}

export interface AgentDraft {
  name: string;
  steps: AgentStepsDoc;
  triggers: TriggerDraft[];
  /** Wanting the agent on; enabling requires at least one trigger. */
  enabled: boolean;
  /** Org-configured model override; null = org default. */
  llmModelId: string | null;
}

export interface ValidationIssue {
  /** Where the issue lives, e.g. 'steps.2.tool' or 'triggers.0'. */
  path: string;
  /** Plain language, shown verbatim in the builder. */
  message: string;
}

function segmentChars(segments: InstructionSegment[]): number {
  return segments.reduce((total, segment) => {
    return total + (segment.t === 'text' ? segment.v.length : segment.name.length);
  }, 0);
}

function validateStep(
  step: AgentStep,
  index: number,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (field: string) => `steps.${index}.${field}`;

  if (step.name.trim().length === 0) {
    issues.push({ path: at('name'), message: 'Give this step a short name.' });
  }
  if (step.instruction.length === 0 || segmentChars(step.instruction) === 0) {
    issues.push({ path: at('instruction'), message: 'Describe what this step should do.' });
  }
  if (segmentChars(step.instruction) > MAX_INSTRUCTION_CHARS) {
    issues.push({
      path: at('instruction'),
      message: `Keep this step under ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`,
    });
  }

  // The one-tool rule, on the chips as well as the field: the chips in the
  // body must be the step's tool and nothing else.
  const chips = toolSegments(step.instruction);
  if (chips.length > 1 || (chips.length === 1 && chips[0] !== step.tool)) {
    issues.push({
      path: at('instruction'),
      message: 'A step can use one skill — remove the extra skill chip.',
    });
  }
  if (step.tool !== null) {
    const descriptor = toolsByName.get(step.tool);
    if (!descriptor) {
      issues.push({
        path: at('tool'),
        message: 'This skill is not available to you — pick one from the list.',
      });
    } else if (descriptor.appOnly) {
      issues.push({ path: at('tool'), message: 'This skill cannot be used in an agent step.' });
    }
  }

  // Failure handling only makes sense against a tool's enumerated outcomes.
  if (step.tool === null && step.failureHandling.length > 0) {
    issues.push({
      path: at('failureHandling'),
      message: 'A step without a skill has no failure conditions to handle.',
    });
  }
  const descriptor = step.tool === null ? undefined : toolsByName.get(step.tool);
  const declaredCodes = new Set(descriptor?.outcomes.failures.map((f) => f.code) ?? []);
  declaredCodes.add('other');
  const seenCodes = new Set<string>();
  step.failureHandling.forEach((handling, handlingIndex) => {
    const hAt = `steps.${index}.failureHandling.${handlingIndex}`;
    if (descriptor && !declaredCodes.has(handling.outcome)) {
      issues.push({
        path: hAt,
        message: 'This failure condition does not belong to the chosen skill.',
      });
    }
    if (seenCodes.has(handling.outcome)) {
      issues.push({ path: hAt, message: 'This failure condition is handled twice.' });
    }
    seenCodes.add(handling.outcome);
    if (handling.action === 'retry') {
      const guidance = handling.guidance ?? [];
      if (guidance.length === 0 || segmentChars(guidance) === 0) {
        issues.push({ path: hAt, message: 'Say what the agent should do differently.' });
      }
      for (const guidanceTool of toolSegments(guidance)) {
        const guidanceDescriptor = toolsByName.get(guidanceTool);
        if (!guidanceDescriptor || guidanceDescriptor.appOnly) {
          issues.push({
            path: hAt,
            message: 'A skill in this guidance is not available to you.',
          });
        }
      }
      for (const name of varSegments(guidance)) {
        if (!knownVariables.has(name)) {
          issues.push({
            path: hAt,
            message: `"${name}" is not something this agent knows — remove or replace the chip.`,
          });
        }
      }
    }
  });

  if (step.saveAs !== undefined && !VARIABLE_NAME_PATTERN.test(step.saveAs)) {
    issues.push({
      path: at('saveAs'),
      message: 'Result names start with a letter and use letters, numbers, spaces, - or _.',
    });
  }

  for (const name of varSegments(step.instruction)) {
    if (!knownVariables.has(name)) {
      issues.push({
        path: at('instruction'),
        message: `"${name}" is not something this agent knows — remove or replace the chip.`,
      });
    }
  }

  return issues;
}

/**
 * Clamp ceilings into the draft. Routes persist THIS, never the raw
 * submission — which is what makes the attempt cap server-enforced no
 * matter what a client sends. The cap itself is the ORG's
 * `agentMaxStepAttempts` setting (routes pass it in); MAX_STEP_ATTEMPTS is
 * only the default for callers with no settings in hand.
 */
export function normalizeAgentDraft(
  draft: AgentDraft,
  options: { attemptsCap?: number } = {}
): AgentDraft {
  const cap = Math.max(1, options.attemptsCap ?? MAX_STEP_ATTEMPTS);
  return {
    ...draft,
    name: draft.name.trim(),
    steps: {
      version: 1,
      steps: draft.steps.steps.map((step) => ({
        ...step,
        name: step.name.trim(),
        // Spaces are legal INSIDE a result name; the edges are trimmed so
        // the pattern (and every later lookup) never meets stray whitespace.
        ...(step.saveAs !== undefined ? { saveAs: step.saveAs.trim() || undefined } : {}),
        maxAttempts: Math.min(
          cap,
          Math.max(1, Math.round(Number.isFinite(step.maxAttempts) ? step.maxAttempts : 1))
        ),
      })),
    },
  };
}

export function validateAgentDraft(
  draft: AgentDraft,
  tools: ToolDescriptorLike[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  if (draft.name.trim().length === 0) {
    issues.push({ path: 'name', message: 'Give the agent a name.' });
  }
  if (draft.name.trim().length > 200) {
    issues.push({ path: 'name', message: 'Keep the name under 200 characters.' });
  }

  const steps = draft.steps.steps;
  if (steps.length === 0) {
    issues.push({ path: 'steps', message: 'Add at least one step.' });
  }
  if (steps.length > MAX_STEPS) {
    issues.push({ path: 'steps', message: `Keep the agent to ${MAX_STEPS} steps or fewer.` });
  }

  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) {
    issues.push({ path: 'steps', message: 'Two steps share an id — reload and try again.' });
  }

  // saveAs names must be unique: a later rebinding would silently change
  // what earlier chips meant.
  const saveAsNames = steps.flatMap((step) => (step.saveAs ? [step.saveAs] : []));
  if (new Set(saveAsNames).size !== saveAsNames.length) {
    issues.push({ path: 'steps', message: 'Two steps save their result under the same name.' });
  }

  // The variable namespace: builtins ∪ trigger-provided ∪ every saveAs.
  // Deliberately not order-sensitive — the doc is linear today, but a chip
  // referencing a later step's result reads as a mistake to a human, so the
  // builder warns on it; the validator only rejects names bound nowhere.
  const knownVariables = new Set<string>([
    ...BUILTIN_VARIABLES.map((variable) => variable.name),
    ...triggerVariableNames(draft.triggers),
    ...saveAsNames,
  ]);

  steps.forEach((step, index) => {
    issues.push(...validateStep(step, index, toolsByName, knownVariables));
  });

  issues.push(
    ...validateTriggerDrafts(draft.triggers).map((issue) => ({
      path: `triggers.${issue.index}`,
      message: issue.message,
    }))
  );

  if (draft.enabled && draft.triggers.length === 0) {
    issues.push({
      path: 'triggers',
      message: 'Add at least one trigger before turning the agent on.',
    });
  }

  return issues;
}
