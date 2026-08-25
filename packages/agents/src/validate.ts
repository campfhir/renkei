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
  APPROVAL_DEFAULT_TIMEOUT_HOURS,
  BRANCH_DEFAULT_ATTEMPTS,
  DEFAULT_APPROVAL_WAIT_CAP_HOURS,
  LOOP_DEFAULT_ATTEMPTS,
  LOOP_DEFAULT_ITERATIONS,
  MAX_BRANCH_DEPTH_V3,
  MAX_BRANCH_PATHS,
  MAX_CONTAINER_DEPTH,
  MAX_GUARDRAILS_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_LOOP_ITERATIONS,
  MAX_STEP_ATTEMPTS,
  MAX_STEPS,
  VARIABLE_NAME_PATTERN,
  approvalPathsOf,
  containsApproval,
  countNodes,
  flattenActionSteps,
  requiredVersion,
  toolSegments,
  varSegments,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type AgentStepsDoc,
  type ApprovalStep,
  type BranchPath,
  type BranchStep,
  type GroupStep,
  type InstructionSegment,
  type LoopStep,
  type TerminalStep,
} from './steps';
import { BUILTIN_VARIABLES } from './variables';
import { isValidTimezone } from './recurrence';
import { resolveTime } from './resolve-time';
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
  /**
   * The agent's standing instructions — role, sources of truth and
   * precedence, content rules, hard rules — injected IN FULL into every
   * model call at run time. Null = none.
   */
  guardrails: string | null;
  /**
   * Act tools the engine refuses for model-driven calls, whatever a step
   * or corrective guidance asks. Terminal-node notifications are exempt
   * (engine-initiated, owner-configured).
   */
  blockedTools: string[];
}

export interface ValidationIssue {
  /** Where the issue lives, e.g. 'steps.2.tool' or 'triggers.0'. */
  path: string;
  /** Plain language, shown verbatim in the builder. */
  message: string;
}

function segmentChars(segments: InstructionSegment[]): number {
  return segments.reduce((total, segment) => {
    switch (segment.t) {
      case 'text':
        return total + segment.v.length;
      case 'tool':
      case 'var':
        return total + segment.name.length;
      case 'date':
        // A date chip renders to a timestamp; count a representative width
        // rather than zero, so the instruction budget stays honest.
        return total + 30;
      default: {
        const unhandled: never = segment;
        throw new Error(`unknown segment: ${JSON.stringify(unhandled)}`);
      }
    }
  }, 0);
}

/**
 * Date chips that cannot resolve. A chip the builder inserted always can —
 * this catches a hand-edited or pasted document, and does it at SAVE time,
 * because the alternative is discovering it in a prompt at 3am as
 * "(unresolved date: …)" inside an instruction that then does the wrong
 * thing.
 */
function dateChipIssues(segments: InstructionSegment[], path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const segment of segments) {
    if (segment.t !== 'date') continue;
    if (!isValidTimezone(segment.timezone)) {
      issues.push({
        path,
        message: `"${segment.timezone}" is not a recognized timezone — re-insert the date chip.`,
      });
      continue;
    }
    const resolved = resolveTime({
      timezone: segment.timezone,
      amount: segment.amount,
      unit: segment.unit,
      ...(segment.atTime ? { atTime: segment.atTime } : {}),
    });
    if (!resolved.ok)
      issues.push({ path, message: `A date chip is not usable: ${resolved.error}` });
  }
  return issues;
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
  issues.push(...dateChipIssues(step.instruction, at('instruction')));

  return issues;
}

/**
 * The containment counters threaded through the recursive validation.
 * Branches and loops each consume a level; groups do not — they exist to
 * organize, not to nest logic.
 */
interface NestingContext {
  branchDepth: number;
  containerDepth: number;
  inLoop: boolean;
}

const TOP_LEVEL: NestingContext = { branchDepth: 0, containerDepth: 0, inLoop: false };

function conditionIssues(
  condition: InstructionSegment[],
  prefix: string,
  knownVariables: Set<string>,
  what: 'condition' | 'stop condition'
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = `${prefix}.condition`;
  if (condition.length === 0 || segmentChars(condition) === 0) {
    issues.push({ path: at, message: `Describe the ${what} to check.` });
  }
  if (segmentChars(condition) > MAX_INSTRUCTION_CHARS) {
    issues.push({
      path: at,
      message: `Keep the ${what} under ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`,
    });
  }
  if (toolSegments(condition).length > 0) {
    issues.push({
      path: at,
      message: `A ${what} can’t use a skill — do that work in a step above, save the result, and decide on it.`,
    });
  }
  for (const name of varSegments(condition)) {
    if (!knownVariables.has(name)) {
      issues.push({
        path: at,
        message: `"${name}" is not something this agent knows — remove or replace the chip.`,
      });
    }
  }
  return issues;
}

function validateBranchStep(
  branch: BranchStep,
  prefix: string,
  context: NestingContext,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const inner: NestingContext = {
    branchDepth: context.branchDepth + 1,
    containerDepth: context.containerDepth + 1,
    inLoop: context.inLoop,
  };

  if (inner.branchDepth > MAX_BRANCH_DEPTH_V3) {
    issues.push({
      path: prefix,
      message: `Conditions can nest ${MAX_BRANCH_DEPTH_V3} levels deep — move this one up.`,
    });
  }
  if (inner.containerDepth > MAX_CONTAINER_DEPTH) {
    issues.push({
      path: prefix,
      message: 'Steps are nested too deeply here — move this up a level.',
    });
  }
  if (branch.name.trim().length === 0) {
    issues.push({ path: `${prefix}.name`, message: 'Give this branch a short name.' });
  }
  issues.push(...conditionIssues(branch.condition, prefix, knownVariables, 'condition'));

  if (branch.paths.length < 2 || branch.paths.length > MAX_BRANCH_PATHS) {
    issues.push({
      path: prefix,
      message: `A branch routes between 2 and ${MAX_BRANCH_PATHS} paths.`,
    });
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
          inner,
          toolsByName,
          knownVariables
        )
      );
    });
  });
  if (branch.failurePath) {
    // An empty failure path is legal on purpose: it means "swallow an
    // evaluation failure and continue after the branch."
    if (branch.failurePath.name.trim().length === 0) {
      issues.push({ path: `${prefix}.failurePath.name`, message: 'Name this path.' });
    }
    branch.failurePath.steps.forEach((node, nodeIndex) => {
      issues.push(
        ...validateNode(
          node,
          `${prefix}.failurePath.steps.${nodeIndex}`,
          inner,
          toolsByName,
          knownVariables
        )
      );
    });
  }
  if (branch.paths.every((path) => path.steps.length === 0)) {
    issues.push({
      path: prefix,
      message: 'This branch does nothing — add a step to a path or remove the branch.',
    });
  }

  return issues;
}

function validateLoopStep(
  loop: LoopStep,
  prefix: string,
  context: NestingContext,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const inner: NestingContext = {
    branchDepth: context.branchDepth,
    containerDepth: context.containerDepth + 1,
    inLoop: true,
  };

  if (context.inLoop) {
    issues.push({
      path: prefix,
      message: 'Loops can’t contain other loops — move this one out.',
    });
  }
  if (inner.containerDepth > MAX_CONTAINER_DEPTH) {
    issues.push({
      path: prefix,
      message: 'Steps are nested too deeply here — move this up a level.',
    });
  }
  if (loop.name.trim().length === 0) {
    issues.push({ path: `${prefix}.name`, message: 'Give this loop a short name.' });
  }
  if (loop.steps.length === 0) {
    issues.push({
      path: prefix,
      message: 'This loop does nothing — add a step inside it or remove it.',
    });
  }

  if (loop.mode === 'foreach') {
    if (!knownVariables.has(loop.itemsVar)) {
      issues.push({
        path: `${prefix}.itemsVar`,
        message: `"${loop.itemsVar}" is not something this agent knows — pick a saved result or trigger input.`,
      });
    }
    if (!VARIABLE_NAME_PATTERN.test(loop.itemVar)) {
      issues.push({
        path: `${prefix}.itemVar`,
        message:
          'Item names start with a letter and use letters, numbers, spaces, ".", "-" or "_" (64 characters max).',
      });
    }
  } else {
    issues.push(...conditionIssues(loop.condition, prefix, knownVariables, 'stop condition'));
  }

  // Collect is both-or-neither, and the source must live INSIDE this body:
  // collecting from a step outside the loop would append the same value
  // every iteration.
  const hasFrom = loop.collectFrom !== undefined && loop.collectFrom !== '';
  const hasVar = loop.collectVar !== undefined && loop.collectVar !== '';
  if (hasFrom !== hasVar) {
    issues.push({
      path: prefix,
      message: 'Collecting results needs both a source step result and a name for the list.',
    });
  }
  if (hasFrom) {
    const bodySaves = new Set(
      flattenActionSteps(loop.steps).flatMap((step) => (step.saveAs ? [step.saveAs] : []))
    );
    if (!bodySaves.has(loop.collectFrom ?? '')) {
      issues.push({
        path: `${prefix}.collectFrom`,
        message: 'Collect from a result that a step INSIDE this loop saves.',
      });
    }
  }
  if (hasVar && !VARIABLE_NAME_PATTERN.test(loop.collectVar ?? '')) {
    issues.push({
      path: `${prefix}.collectVar`,
      message:
        'List names start with a letter and use letters, numbers, spaces, ".", "-" or "_" (64 characters max).',
    });
  }

  loop.steps.forEach((node, nodeIndex) => {
    issues.push(
      ...validateNode(node, `${prefix}.steps.${nodeIndex}`, inner, toolsByName, knownVariables)
    );
  });

  return issues;
}

function validateGroupStep(
  group: GroupStep,
  prefix: string,
  context: NestingContext,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (group.name.trim().length === 0) {
    issues.push({ path: `${prefix}.name`, message: 'Give this group a short name.' });
  }
  if (group.steps.length === 0) {
    issues.push({
      path: prefix,
      message: 'This group is empty — add a step inside it or remove it.',
    });
  }
  // Depth-neutral: the same context flows through.
  group.steps.forEach((node, nodeIndex) => {
    issues.push(
      ...validateNode(node, `${prefix}.steps.${nodeIndex}`, context, toolsByName, knownVariables)
    );
  });
  return issues;
}

function validateTerminalStep(
  terminal: TerminalStep,
  prefix: string,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (terminal.name.trim().length === 0) {
    issues.push({ path: `${prefix}.name`, message: 'Give this ending a short name.' });
  }
  const notifies = terminal.notifyEmail || terminal.notifyWebex;
  if (notifies && segmentChars(terminal.message) === 0) {
    issues.push({
      path: `${prefix}.message`,
      message: 'Say what the notification should tell you — that message is the whole point.',
    });
  }
  if (segmentChars(terminal.message) > MAX_INSTRUCTION_CHARS) {
    issues.push({
      path: `${prefix}.message`,
      message: `Keep the message under ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`,
    });
  }
  if (toolSegments(terminal.message).length > 0) {
    issues.push({
      path: `${prefix}.message`,
      message: 'An ending can’t use a skill — its message is delivered as-is.',
    });
  }
  for (const name of varSegments(terminal.message)) {
    if (!knownVariables.has(name)) {
      issues.push({
        path: `${prefix}.message`,
        message: `"${name}" is not something this agent knows — remove or replace the chip.`,
      });
    }
  }
  return issues;
}

function validateApprovalStep(
  approval: ApprovalStep,
  prefix: string,
  context: NestingContext,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // Branch-like containment: a pause routes between outcome paths, so it
  // spends the same nesting budgets a branch does.
  const inner: NestingContext = {
    branchDepth: context.branchDepth + 1,
    containerDepth: context.containerDepth + 1,
    inLoop: context.inLoop,
  };
  if (inner.branchDepth > MAX_BRANCH_DEPTH_V3) {
    issues.push({
      path: prefix,
      message: `Conditions can nest ${MAX_BRANCH_DEPTH_V3} levels deep — move this approval up.`,
    });
  }
  if (inner.containerDepth > MAX_CONTAINER_DEPTH) {
    issues.push({
      path: prefix,
      message: 'Steps are nested too deeply here — move this up a level.',
    });
  }
  if (approval.name.trim().length === 0) {
    issues.push({ path: `${prefix}.name`, message: 'Give this approval a short name.' });
  }

  // The message is the card body — without it the owner is asked to
  // approve nothing in particular.
  if (approval.message.length === 0 || segmentChars(approval.message) === 0) {
    issues.push({
      path: `${prefix}.message`,
      message: 'Say what you are being asked to approve or answer.',
    });
  }
  if (segmentChars(approval.message) > MAX_INSTRUCTION_CHARS) {
    issues.push({
      path: `${prefix}.message`,
      message: `Keep the message under ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`,
    });
  }
  if (toolSegments(approval.message).length > 0) {
    issues.push({
      path: `${prefix}.message`,
      message: 'An approval message can’t use a skill — it is shown to you as written.',
    });
  }
  for (const name of varSegments(approval.message)) {
    if (!knownVariables.has(name)) {
      issues.push({
        path: `${prefix}.message`,
        message: `"${name}" is not something this agent knows — remove or replace the chip.`,
      });
    }
  }

  if (approval.mode === 'input') {
    if (!approval.saveAs || !VARIABLE_NAME_PATTERN.test(approval.saveAs)) {
      issues.push({
        path: `${prefix}.saveAs`,
        message: approval.saveAs
          ? 'Answer names start with a letter and use letters, numbers, spaces, ".", "-" or "_" (64 characters max).'
          : 'Name the answer so later steps can use it.',
      });
    }
  }

  if (!Number.isFinite(approval.timeoutHours) || approval.timeoutHours < 1) {
    issues.push({
      path: `${prefix}.timeoutHours`,
      message: 'The wait ceiling must be at least one hour.',
    });
  }

  for (const { key, path } of approvalPathsOf(approval)) {
    if (path.name.trim().length === 0) {
      issues.push({ path: `${prefix}.${key}.name`, message: 'Name this path.' });
    }
    path.steps.forEach((node, nodeIndex) => {
      issues.push(
        ...validateNode(
          node,
          `${prefix}.${key}.steps.${nodeIndex}`,
          inner,
          toolsByName,
          knownVariables
        )
      );
    });
  }

  return issues;
}

function validateNode(
  node: AgentStepNode,
  prefix: string,
  context: NestingContext,
  toolsByName: Map<string, ToolDescriptorLike>,
  knownVariables: Set<string>
): ValidationIssue[] {
  // Exhaustive on purpose: a node kind with no arm here is a compile
  // error, never an action-step validation of something that isn't one.
  switch (node.kind) {
    case 'branch':
      return validateBranchStep(node, prefix, context, toolsByName, knownVariables);
    case 'loop':
      return validateLoopStep(node, prefix, context, toolsByName, knownVariables);
    case 'group':
      return validateGroupStep(node, prefix, context, toolsByName, knownVariables);
    case 'terminal':
      return validateTerminalStep(node, prefix, knownVariables);
    case 'approval':
      return validateApprovalStep(node, prefix, context, toolsByName, knownVariables);
    case 'action':
    case undefined:
      return validateActionStep(node, prefix, toolsByName, knownVariables);
    default: {
      const unhandled: never = node;
      throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * A terminal node ends the WHOLE run, so siblings after one can never run.
 * Flagged on the terminal itself (the node the user just placed) — one
 * actionable message instead of an echo on every shadowed sibling.
 */
function terminalPlacementIssues(nodes: AgentStepNode[], prefix: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  nodes.forEach((node, index) => {
    const at = `${prefix}.${index}`;
    switch (node.kind) {
      case 'terminal':
        if (index < nodes.length - 1) {
          issues.push({
            path: at,
            message:
              'Steps below this ending can never run — make it the last step here, or move them above it.',
          });
        }
        break;
      case 'branch':
        node.paths.forEach((path, pathIndex) => {
          issues.push(...terminalPlacementIssues(path.steps, `${at}.paths.${pathIndex}.steps`));
        });
        if (node.failurePath) {
          issues.push(
            ...terminalPlacementIssues(node.failurePath.steps, `${at}.failurePath.steps`)
          );
        }
        break;
      case 'loop':
      case 'group':
        issues.push(...terminalPlacementIssues(node.steps, `${at}.steps`));
        break;
      case 'approval':
        for (const { key, path } of approvalPathsOf(node)) {
          issues.push(...terminalPlacementIssues(path.steps, `${at}.${key}.steps`));
        }
        break;
      case 'action':
      case undefined:
        break;
      default: {
        const unhandled: never = node;
        throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  });
  return issues;
}

function clampAttempts(value: number, cap: number, fallback: number): number {
  return Math.min(cap, Math.max(1, Math.round(Number.isFinite(value) ? value : fallback)));
}

function clampIterations(value: number): number {
  return Math.min(
    MAX_LOOP_ITERATIONS,
    Math.max(1, Math.round(Number.isFinite(value) ? value : LOOP_DEFAULT_ITERATIONS))
  );
}

function normalizeNode(node: AgentStepNode, cap: number, waitCapHours: number): AgentStepNode {
  switch (node.kind) {
    case 'branch': {
      const normalizePath = (path: BranchPath): BranchPath => ({
        ...path,
        name: path.name.trim(),
        steps: path.steps.map((child) => normalizeNode(child, cap, waitCapHours)),
      });
      return {
        ...node,
        name: node.name.trim(),
        maxAttempts: clampAttempts(node.maxAttempts, cap, BRANCH_DEFAULT_ATTEMPTS),
        paths: node.paths.map(normalizePath),
        ...(node.failurePath !== undefined ? { failurePath: normalizePath(node.failurePath) } : {}),
      };
    }
    case 'loop': {
      const collect =
        node.collectFrom?.trim() && node.collectVar?.trim()
          ? { collectFrom: node.collectFrom.trim(), collectVar: node.collectVar.trim() }
          : {};
      const steps = node.steps.map((child) => normalizeNode(child, cap, waitCapHours));
      if (node.mode === 'foreach') {
        const { collectFrom: _f, collectVar: _v, ...rest } = node;
        return {
          ...rest,
          ...collect,
          name: node.name.trim(),
          itemsVar: node.itemsVar.trim(),
          itemVar: node.itemVar.trim(),
          maxIterations: clampIterations(node.maxIterations),
          steps,
        };
      }
      const { collectFrom: _f, collectVar: _v, ...rest } = node;
      return {
        ...rest,
        ...collect,
        name: node.name.trim(),
        maxAttempts: clampAttempts(node.maxAttempts, cap, LOOP_DEFAULT_ATTEMPTS),
        maxIterations: clampIterations(node.maxIterations),
        steps,
      };
    }
    case 'group':
      return {
        ...node,
        name: node.name.trim(),
        steps: node.steps.map((child) => normalizeNode(child, cap, waitCapHours)),
      };
    case 'terminal':
      return { ...node, name: node.name.trim() };
    case 'approval': {
      const normalizePath = (path: BranchPath): BranchPath => ({
        ...path,
        name: path.name.trim(),
        steps: path.steps.map((child) => normalizeNode(child, cap, waitCapHours)),
      });
      return {
        ...node,
        name: node.name.trim(),
        ...(node.saveAs !== undefined ? { saveAs: node.saveAs.trim() || undefined } : {}),
        // The org's wait cap binds here AND live at pause time — the
        // stricter of the two always wins.
        timeoutHours: Math.min(
          Math.max(1, waitCapHours),
          Math.max(
            1,
            Math.round(
              Number.isFinite(node.timeoutHours)
                ? node.timeoutHours
                : APPROVAL_DEFAULT_TIMEOUT_HOURS
            )
          )
        ),
        onApproved: normalizePath(node.onApproved),
        onDeclined: normalizePath(node.onDeclined),
        onTimeout: normalizePath(node.onTimeout),
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
  options: {
    attemptsCap?: number;
    /** Org ceiling on approval waits, in hours (agentApprovalMaxWaitDays × 24). */
    approvalWaitCapHours?: number;
  } = {}
): AgentDraft {
  const cap = Math.max(1, options.attemptsCap ?? MAX_STEP_ATTEMPTS);
  const waitCapHours = Math.max(1, options.approvalWaitCapHours ?? DEFAULT_APPROVAL_WAIT_CAP_HOURS);
  const steps = draft.steps.steps.map((node) => normalizeNode(node, cap, waitCapHours));
  const guardrails = draft.guardrails?.trim() || null;
  return {
    ...draft,
    name: draft.name.trim(),
    guardrails,
    // Deduped, order preserved; empty entries dropped.
    blockedTools: [...new Set(draft.blockedTools.map((tool) => tool.trim()).filter(Boolean))],
    steps: {
      // The SERVER owns the version rule (requiredVersion): a document any
      // older writer could produce keeps its exact old version, so linear
      // and plain-branch agents stay runnable by older workers.
      version: requiredVersion(steps),
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
    if ((node.kind === undefined || node.kind === 'action') && node.saveAs) {
      out.set(node.saveAs, depth === 1 ? 'always' : 'conditional');
    }
    // An approval answer binds only on the answered outcome — conditional
    // wherever the node sits.
    if (node.kind === 'approval' && node.saveAs) {
      out.set(node.saveAs, 'conditional');
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
  // A sanity bound, not a style rule — guardrails are injected in full on
  // purpose, so length is the owner's cost choice; this only stops a paste
  // accident from parking a megabyte in every prompt.
  if ((draft.guardrails?.length ?? 0) > MAX_GUARDRAILS_CHARS) {
    issues.push({
      path: 'guardrails',
      message: `The guardrails document is too long to inject — keep it under ${MAX_GUARDRAILS_CHARS.toLocaleString()} characters.`,
    });
  }

  const nodes = draft.steps.steps;
  const walked = walkSteps(nodes);
  if (nodes.length === 0) {
    issues.push({ path: 'steps', message: 'Add at least one step.' });
  }
  if (countNodes(nodes) > MAX_STEPS) {
    issues.push({ path: 'steps', message: `Keep the agent to ${MAX_STEPS} steps or fewer.` });
  }

  // Doc-wide id uniqueness — node ids AND branch-path ids (failure path
  // included) share the space: run records reference node ids and resume
  // walks the tree by them.
  const allIds = walked.flatMap(({ node }) => {
    switch (node.kind) {
      case 'branch':
        return [
          node.id,
          ...node.paths.map((path) => path.id),
          ...(node.failurePath ? [node.failurePath.id] : []),
        ];
      case 'approval':
        return [node.id, ...approvalPathsOf(node).map(({ path }) => path.id)];
      case 'loop':
      case 'group':
      case 'terminal':
      case 'action':
      case undefined:
        return [node.id];
      default: {
        const unhandled: never = node;
        throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  });
  if (new Set(allIds).size !== allIds.length) {
    issues.push({ path: 'steps', message: 'Two steps share an id — reload and try again.' });
  }

  // Every name that BINDS a value shares one namespace: saveAs results,
  // loop item names, and collected lists. A collision would silently change
  // what earlier chips meant.
  const actionSteps = flattenActionSteps(nodes);
  const saveAsNames = actionSteps.flatMap((step) => (step.saveAs ? [step.saveAs] : []));
  const loopBindings = walked.flatMap(({ node }) => {
    if (node.kind !== 'loop') return [];
    return [
      ...(node.mode === 'foreach' ? [node.itemVar] : []),
      ...(node.collectVar ? [node.collectVar] : []),
    ];
  });
  // Approval answers bind names too (input mode).
  const approvalBindings = walked.flatMap(({ node }) =>
    node.kind === 'approval' && node.saveAs ? [node.saveAs] : []
  );
  const boundNames = [...saveAsNames, ...loopBindings, ...approvalBindings];
  if (new Set(boundNames).size !== boundNames.length) {
    issues.push({
      path: 'steps',
      message: 'Two steps bind a result, item, or list under the same name.',
    });
  }

  // The variable namespace: builtins ∪ trigger-provided ∪ every binding.
  // Deliberately not order-sensitive, and PERMISSIVE across branch paths
  // and loop bodies — a save inside one path is referenceable after the
  // branch (the runtime renders an unset var as `(unknown: name)` and
  // reports it, so a wiring miss is visible, not silent). The builder may
  // hint via savesByPathCoverage; the validator only rejects names bound
  // nowhere.
  const knownVariables = new Set<string>([
    ...BUILTIN_VARIABLES.map((variable) => variable.name),
    ...triggerVariableNames(draft.triggers),
    ...boundNames,
    // The pause binds the card/run link for its outcome paths and beyond.
    ...(containsApproval(nodes) ? ['approval.link'] : []),
  ]);

  nodes.forEach((node, index) => {
    issues.push(...validateNode(node, `steps.${index}`, TOP_LEVEL, toolsByName, knownVariables));
  });
  issues.push(...terminalPlacementIssues(nodes, 'steps'));

  // Blocked skills — the guardrails' mechanical arm. A step configured to
  // use one is a contradiction worth failing at save, not discovering at
  // run time (where the engine refuses it as a guard stop).
  const blocked = new Set(draft.blockedTools);
  if (blocked.size > 0) {
    for (const { node, path } of walked) {
      if (node.kind !== undefined && node.kind !== 'action') continue;
      if (node.tool && blocked.has(node.tool)) {
        issues.push({
          path: `${path}.tool`,
          message:
            'This skill is blocked by the agent’s guardrails — unblock it or pick another skill.',
        });
      }
      node.failureHandling.forEach((handling, handlingIndex) => {
        for (const guidanceTool of toolSegments(handling.guidance ?? [])) {
          if (blocked.has(guidanceTool)) {
            issues.push({
              path: `${path}.failureHandling.${handlingIndex}`,
              message: 'A skill in this guidance is blocked by the agent’s guardrails.',
            });
          }
        }
      });
    }
  }

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
