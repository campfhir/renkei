/**
 * @renkei/agents — the shared core of user-drafted agents.
 *
 * What lives here is exactly what both the web app and the agents worker
 * need to agree on: the agent definition (instructions + tools) and the
 * validator that enforces the platform's rules on the way in, the staged
 * action batch shape, recurrence math for schedule triggers, the trigger
 * catalog (the builder's event vocabulary AND the worker's emission
 * contract), and run creation with its guards.
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
  DEFAULT_APPROVAL_WAIT_CAP_HOURS,
  INSTRUCTION_SECTIONS,
  MAX_AGENT_TOOLS,
  MAX_GUARDRAILS_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  VARIABLE_NAME_PATTERN,
  agentDefinitionOf,
  instructionsHaveContent,
  instructionsSkeleton,
  isAgentDefinition,
  normalizeAgentDraft,
  parseAgentDefinition,
  validateAgentDraft,
  type AgentDefinition,
  type AgentDraft,
  type ToolDescriptorLike,
  type ValidationIssue,
} from './definition';
export {
  MAX_QUESTION_FIELDS,
  MAX_QUESTION_FIELD_HELP_CHARS,
  MAX_QUESTION_FIELD_KEY_CHARS,
  MAX_QUESTION_FIELD_LABEL_CHARS,
  MAX_QUESTION_FIELD_OPTIONS,
  MAX_QUESTION_FIELD_OPTION_CHARS,
  isQuestionField,
  parseQuestionFields,
  type QuestionField,
  type QuestionFieldType,
} from './question-field';
export {
  ACTION_RESULT_CHARS,
  MAX_ACTION_REASON_CHARS,
  MAX_BATCH_SUMMARY_CHARS,
  MAX_STAGED_ACTIONS,
  batchReportForAgent,
  isStagedAction,
  parseStagedActions,
  parseStoredActions,
  parseStoredResults,
  type ActionBatchStatus,
  type ActionOutcome,
  type ActionResult,
  type StagedAction,
} from './action-batch';
export {
  MAX_FORM_GROUP_DEPTH,
  MAX_FORM_GROUP_LABEL_CHARS,
  MAX_FORM_GROUP_NODES,
  MAX_FORM_NODES,
  MAX_FORM_PARAGRAPH_CHARS,
  countFormNodes,
  flattenFormFields,
  isFormNode,
  parseFormNodes,
  type FormNode,
} from './question-form';
export {
  MAX_QUESTION_ANSWER_CHARS,
  checkQuestionAnswers,
  describeQuestionAnswer,
  questionAnswerText,
  type QuestionAnswerIssue,
  type QuestionAnswerValue,
  type QuestionAnswersResult,
} from './question-answers';
export {
  ALWAYS_APPROVAL_TOOLS,
  actApprovalReason,
  isAlwaysApprovalTool,
  isExternallyTriggered,
  type ActApprovalInput,
  type ActApprovalReason,
  type ToolKindHint,
} from './act-approval';
export { UNTRUSTED_RULE, UNTRUSTED_TAG, untrustedBlock } from './untrusted';
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
  isActiveHoursWindow,
  recurrenceIssue,
  isValidDateString,
  isValidTimezone,
  MAX_SCHEDULE_RULES,
  MAX_SCHEDULE_BLACKOUTS,
  MAX_ACTIVE_HOURS,
  type Recurrence,
  type ScheduleConfig,
  type BlackoutEntry,
  type BlackoutPolicy,
  type ActiveHoursWindow,
  type Weekday,
} from './recurrence';
export { BUILTIN_VARIABLES, isUntrustedVariable, type VariableDescriptor } from './variables';
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
  triggerDraftIssue,
  triggerVariableDescriptors,
  triggerVariableNames,
  validateTriggerDrafts,
  type ApiTriggerInput,
  type TriggerDraft,
  type TriggerIssue,
} from './triggers';

export {
  isTimeUnit,
  resolveTime,
  TIME_UNITS,
  type ResolveTimeRequest,
  type ResolvedTime,
  type TimeUnit,
} from './resolve-time';

export { friendlyToolName } from './tool-name';
export {
  SEALED_DETAIL_FIELDS,
  SEALED_DETAIL_KEY,
  mergeOpenedDetail,
  outlineToolCalls,
  sealedDetailOf,
  splitDetailForSealing,
} from './turn-detail';
