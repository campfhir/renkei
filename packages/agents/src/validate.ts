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
 * the submitted one — including the VERSION, which the normalizer computes
 * (2 iff a branch exists) no matter what the client sent.
 *
 * Tool existence is checked against the SAVING USER's tool projection
 * (whatever list the caller passes — the web fetches it from the catalog).
 * Losing a tool later does not invalidate the saved agent; availability is
 * a runtime property owned by the gates, and the engine pre-flights it per
 * run.
 *
 * Issue paths are all-numeric and recursive — `steps.2.condition`,
 * `steps.2.paths.1.steps.0.instruction` — so a UI can claim issues by
 * longest prefix at every nesting level.
 */

import {
  BRANCH_DEFAULT_ATTEMPTS,
  MAX_BRANCH_DEPTH,
  MAX_INSTRUCTION_CHARS,
  MAX_STEP_ATTEMPTS,
  MAX_STEPS,
  VARIABLE_NAME_PATTERN,
  containsBranch,
  countNodes,
  flattenActionSteps,
  isBranchStep,
  toolSegments,
  varSegments,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type AgentStepsDoc,
  type BranchPath,
  type BranchStep,
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

function validateActionStep(
  step: ActionStep,
  prefix: string,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (field: string) => `${prefix}.${field}`;

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
    const hAt = `${prefix}.failureHandling.${handlingIndex}`;
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
      message:
        'Result names start with a letter and use letters, numbers, spaces, ".", "-" or "_" (64 characters max).',
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

function validateBranchStep(
  branch: BranchStep,
  prefix: string,
  depth: number,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (depth > MAX_BRANCH_DEPTH) {
    issues.push({
      path: prefix,
      message: 'Branches can only nest one level deep — move this one up.',
    });
  }
  if (branch.name.trim().length === 0) {
    issues.push({ path: `${prefix}.name`, message: 'Give this branch a short name.' });
  }
  if (branch.condition.length === 0 || segmentChars(branch.condition) === 0) {
    issues.push({ path: `${prefix}.condition`, message: 'Describe the condition to check.' });
  }
  if (segmentChars(branch.condition) > MAX_INSTRUCTION_CHARS) {
    issues.push({
      path: `${prefix}.condition`,
      message: `Keep the condition under ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`,
    });
  }
  if (toolSegments(branch.condition).length > 0) {
    issues.push({
      path: `${prefix}.condition`,
      message:
        'A branch can’t use a skill — do that work in a step above, save the result, and branch on it.',
    });
  }
  for (const name of varSegments(branch.condition)) {
    if (!knownVariables.has(name)) {
      issues.push({
        path: `${prefix}.condition`,
        message: `"${name}" is not something this agent knows — remove or replace the chip.`,
      });
    }
  }
  branch.paths.forEach((path, pathIndex) => {
    if (path.name.trim().length === 0) {
      issues.push({ path: `${prefix}.paths.${pathIndex}.name`, message: 'Name this path.' });
    }
    path.steps.forEach((node, nodeIndex) => {
      issues.push(
        ...validateNode(
          node,
          `${prefix}.paths.${pathIndex}.steps.${nodeIndex}`,
          depth + 1,
          toolsByName,
          knownVariables
        )
      );
    });
  });
  if (branch.paths.every((path) => path.steps.length === 0)) {
    issues.push({
      path: prefix,
      message: 'This branch does nothing — add a step to a path or remove the branch.',
    });
  }

  return issues;
}

function validateNode(
  node: AgentStepNode,
  prefix: string,
  depth: number,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  // Exhaustive on purpose: a node kind with no arm here is a compile
  // error, never an action-step validation of something that isn't one.
  switch (node.kind) {
    case 'branch':
      return validateBranchStep(node, prefix, depth, toolsByName, knownVariables);
    case 'action':
    case undefined:
      return validateActionStep(node, prefix, toolsByName, knownVariables);
    default: {
      const unhandled: never = node;
      throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

function clampAttempts(value: number, cap: number, fallback: number): number {
  return Math.min(cap, Math.max(1, Math.round(Number.isFinite(value) ? value : fallback)));
}

function normalizeNode(node: AgentStepNode, cap: number): AgentStepNode {
  switch (node.kind) {
    case 'branch': {
      const normalizePath = (path: BranchPath): BranchPath => ({
        ...path,
        name: path.name.trim(),
        steps: path.steps.map((child) => normalizeNode(child, cap)),
      });
      const paths: [BranchPath, BranchPath] = [
        normalizePath(node.paths[0]),
        normalizePath(node.paths[1]),
      ];
      return {
        ...node,
        name: node.name.trim(),
        maxAttempts: clampAttempts(node.maxAttempts, cap, BRANCH_DEFAULT_ATTEMPTS),
        paths,
      };
    }
    case 'action':
    case undefined: {
      // Strip the optional discriminant so linear documents stay
      // byte-identical with what pre-branch builds wrote.
      const { kind: _kind, ...step } = node;
      return {
        ...step,
        name: step.name.trim(),
        // Spaces are legal INSIDE a result name; the edges are trimmed so
        // the pattern (and every later lookup) never meets stray whitespace.
        ...(step.saveAs !== undefined ? { saveAs: step.saveAs.trim() || undefined } : {}),
        maxAttempts: clampAttempts(step.maxAttempts, cap, 1),
      };
    }
    default: {
      const unhandled: never = node;
      throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
    }
  }
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
  const steps = draft.steps.steps.map((node) => normalizeNode(node, cap));
  return {
    ...draft,
    name: draft.name.trim(),
    steps: {
      // The SERVER owns the version rule: 2 iff a branch exists, so linear
      // agents stay runnable by workers that predate branching.
      version: containsBranch(steps) ? 2 : 1,
      steps,
    },
  };
}

/**
 * Which saveAs names are bound on EVERY run ('always': top level) vs only
 * when some branch path runs ('conditional'). The validator stays
 * permissive either way — this exists so a UI can hint "may be unset".
 */
export function savesByPathCoverage(nodes: AgentStepNode[]): Map<string, 'always' | 'conditional'> {
  const out = new Map<string, 'always' | 'conditional'>();
  for (const { node, depth } of walkSteps(nodes)) {
    if (!isBranchStep(node) && node.saveAs) {
      out.set(node.saveAs, depth === 1 ? 'always' : 'conditional');
    }
  }
  return out;
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

  const nodes = draft.steps.steps;
  const walked = walkSteps(nodes);
  if (nodes.length === 0) {
    issues.push({ path: 'steps', message: 'Add at least one step.' });
  }
  if (countNodes(nodes) > MAX_STEPS) {
    issues.push({ path: 'steps', message: `Keep the agent to ${MAX_STEPS} steps or fewer.` });
  }

  // Doc-wide id uniqueness — node ids AND branch-path ids share the space:
  // run records reference node ids and resume walks the tree by them.
  const allIds = walked.flatMap(({ node }) =>
    isBranchStep(node) ? [node.id, node.paths[0].id, node.paths[1].id] : [node.id]
  );
  if (new Set(allIds).size !== allIds.length) {
    issues.push({ path: 'steps', message: 'Two steps share an id — reload and try again.' });
  }

  // saveAs names must be unique: a later rebinding would silently change
  // what earlier chips meant.
  const actionSteps = flattenActionSteps(nodes);
  const saveAsNames = actionSteps.flatMap((step) => (step.saveAs ? [step.saveAs] : []));
  if (new Set(saveAsNames).size !== saveAsNames.length) {
    issues.push({ path: 'steps', message: 'Two steps save their result under the same name.' });
  }

  // The variable namespace: builtins ∪ trigger-provided ∪ every saveAs.
  // Deliberately not order-sensitive, and PERMISSIVE across branch paths —
  // a save inside one path is referenceable after the branch (the runtime
  // renders an unset var as `(unknown: name)` and reports it, so a wiring
  // miss is visible, not silent). The builder may hint via
  // savesByPathCoverage; the validator only rejects names bound nowhere.
  const knownVariables = new Set<string>([
    ...BUILTIN_VARIABLES.map((variable) => variable.name),
    ...triggerVariableNames(draft.triggers),
    ...saveAsNames,
  ]);

  nodes.forEach((node, index) => {
    issues.push(...validateNode(node, `steps.${index}`, 1, toolsByName, knownVariables));
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
