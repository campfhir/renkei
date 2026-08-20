/**
 * @renkei/agents — the shared core of user-drafted agents.
 *
 * What lives here is exactly what both the web app and the agents worker
 * need to agree on: the steps document (types + structural guards), the
 * validator that enforces the platform's rules on the way in, the renderer
 * that turns chip segments into prompt text, recurrence math for schedule
 * triggers, the trigger catalog (the builder's event vocabulary AND the
 * worker's emission contract), and run creation with its guards.
 *
 * What deliberately does NOT live here: the LLM layer (@renkei/agent-llm),
 * the execution engine (apps/worker-agents), tool catalog resolution (the
 * web's mcp-tools, injected as ToolDescriptorLike), and any UI.
 *
 * This barrel is CLIENT-SAFE on purpose — the builder imports it into the
 * browser bundle. Run creation (db + queue + settings) lives behind the
 * separate `@renkei/agents/runs` entry so importing the types can never
 * drag `pg` into a client component.
 */

export {
  BRANCH_DEFAULT_ATTEMPTS,
  MAX_BRANCH_DEPTH,
  MAX_INSTRUCTION_CHARS,
  MAX_STEP_ATTEMPTS,
  MAX_STEPS,
  VARIABLE_NAME_PATTERN,
  containsBranch,
  countNodes,
  findNodeById,
  flattenActionSteps,
  isAgentStepsDoc,
  isBranchStep,
  isInstructionSegment,
  toolSegments,
  varSegments,
  walkSteps,
  type ActionStep,
  type AgentStep,
  type AgentStepNode,
  type AgentStepsDoc,
  type BranchPath,
  type BranchStep,
  type FailureHandling,
  type FoundNode,
  type InstructionSegment,
  type WalkedNode,
} from './steps';
export {
  normalizeAgentDraft,
  savesByPathCoverage,
  validateAgentDraft,
  type AgentDraft,
  type ToolDescriptorLike,
  type ValidationIssue,
} from './validate';
export { instructionPreview, renderInstruction, type RenderResult } from './render';
export {
  computeNextRun,
  computeNextRunForSchedule,
  parseScheduleConfig,
  serializeScheduleConfig,
  blackoutPredicate,
  describeRecurrence,
  describeSchedule,
  isRecurrence,
  isBlackoutEntry,
  isValidDateString,
  isValidTimezone,
  MAX_SCHEDULE_RULES,
  MAX_SCHEDULE_BLACKOUTS,
  type Recurrence,
  type ScheduleConfig,
  type BlackoutEntry,
  type BlackoutPolicy,
  type Weekday,
} from './recurrence';
export { BUILTIN_VARIABLES, type VariableDescriptor } from './variables';
export {
  TRIGGER_EVENT_CATALOG,
  triggerEventById,
  type TriggerEventDescriptor,
} from './trigger-catalog';
export {
  isTriggerDraft,
  triggerVariableDescriptors,
  triggerVariableNames,
  validateTriggerDrafts,
  type ApiTriggerInput,
  type TriggerDraft,
  type TriggerIssue,
} from './triggers';
