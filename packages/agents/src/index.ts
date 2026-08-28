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
  APPROVAL_DEFAULT_TIMEOUT_HOURS,
  APPROVAL_OUTCOME_KEYS,
  BRANCH_DEFAULT_ATTEMPTS,
  CURRENT_STEPS_VERSION,
  CUSTOM_OUTCOME_CODE_PATTERN,
  DEFAULT_APPROVAL_WAIT_CAP_HOURS,
  LOOP_DEFAULT_ATTEMPTS,
  LOOP_DEFAULT_ITERATIONS,
  MAX_BRANCH_DEPTH_V3,
  MAX_BRANCH_PATHS,
  MAX_COLLECTED_ITEMS,
  MAX_CONTAINER_DEPTH,
  MAX_GUARDRAILS_CHARS,
  MAX_GUIDANCE_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_LOOP_ITERATIONS,
  MAX_OUTCOME_CODE_CHARS,
  MAX_OUTCOME_WHEN_CHARS,
  MAX_STEP_ATTEMPTS,
  MAX_STEPS,
  VARIABLE_NAME_PATTERN,
  approvalPathsOf,
  containsApproval,
  countNodes,
  customOutcomeSlug,
  findNodeById,
  flattenActionSteps,
  isAgentStepsDoc,
  isApprovalStep,
  isBranchStep,
  isContainerNode,
  isCurrentStepsDoc,
  isGroupStep,
  isInstructionSegment,
  isLoopStep,
  isTerminalStep,
  nodeKind,
  nodeUsesModel,
  toolSegments,
  varSegments,
  walkSteps,
  type ActionStep,
  type AgentStep,
  type AgentStepNode,
  type AgentStepsDoc,
  type DateSegment,
  type ApprovalMode,
  type ApprovalOutcomeKey,
  type ApprovalStep,
  type BranchPath,
  type BranchStep,
  type FailureHandling,
  type ForEachLoopStep,
  type FoundAncestor,
  type FoundNode,
  type GroupStep,
  type InstructionSegment,
  type LoopStep,
  type NodeKind,
  type TerminalResult,
  type TerminalStep,
  type UntilLoopStep,
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
export {
  instructionPreview,
  renderDateSegment,
  renderInstruction,
  type RenderResult,
} from './render';
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
  describeTriggerMatch,
  isEmptyTriggerMatch,
  matchesTriggerEvent,
  normalizeMatchForEvent,
  triggerEventById,
  triggerFilterFields,
  validateMatchForEvent,
  type TriggerEventDescriptor,
} from './trigger-catalog';
export {
  DEFAULT_FILTER_MODE,
  MAX_FILTER_ENTRIES,
  describeFilters,
  filterModeOf,
  isEmptyMatch,
  isTriggerMatch,
  matchesFilters,
  normalizeMatch,
  validateMatch,
  type FilterInputKind,
  type FilterMatchKind,
  type FilterMatchMode,
  type FilterOptionSource,
  type FilterSelectOption,
  type TriggerFilterField,
  type TriggerMatch,
  type TriggerMatchValue,
} from './trigger-filters';
export {
  isTriggerDraft,
  triggerVariableDescriptors,
  triggerVariableNames,
  validateTriggerDrafts,
  type ApiTriggerInput,
  type TriggerDraft,
  type TriggerIssue,
} from './triggers';

export {
  describeDateSegment,
  resolveTime,
  TIME_UNITS,
  type ResolveTimeRequest,
  type ResolvedTime,
  type TimeUnit,
} from './resolve-time';

export { friendlyToolName } from './tool-name';
