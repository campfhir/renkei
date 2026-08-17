/**
 * Trigger drafts: what the builder edits and the CRUD routes persist onto
 * `agent_triggers` rows.
 *
 * The draft is the user's intent; the row adds server-derived fields the
 * draft must never carry — an API trigger's `keyHash` is minted server-side
 * and shown once, `event_source`/`event_type` are denormalized from the
 * catalog id, and `next_run_at` is computed from the recurrence. Routes map
 * draft → row; nothing here touches the database.
 */

import {
  isBlackoutEntry,
  isRecurrence,
  isValidDateString,
  isValidTimezone,
  MAX_SCHEDULE_BLACKOUTS,
  MAX_SCHEDULE_RULES,
  type ScheduleConfig,
} from './recurrence';
import { triggerEventById } from './trigger-catalog';
import { VARIABLE_NAME_PATTERN } from './steps';

export interface ApiTriggerInput {
  /** Becomes the `trigger.<name>` variable steps can reference. */
  name: string;
  label: string;
}

export type TriggerDraft =
  | {
      kind: 'event';
      /** TRIGGER_EVENT_CATALOG id, e.g. 'microsoft/mail.received'. */
      eventId: string;
      match?: { fromDomain?: string; subjectContains?: string };
    }
  | ({ kind: 'schedule' } & ScheduleConfig)
  | { kind: 'agent'; callerAgentId: string }
  | { kind: 'api'; inputs: ApiTriggerInput[] };

export interface TriggerIssue {
  /** Index into the drafts array the issue belongs to. */
  index: number;
  message: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateOne(draft: TriggerDraft, index: number): TriggerIssue[] {
  const issues: TriggerIssue[] = [];
  switch (draft.kind) {
    case 'event': {
      if (!triggerEventById(draft.eventId)) {
        issues.push({ index, message: 'Choose an event from the list.' });
      }
      const fromDomain = draft.match?.fromDomain;
      if (fromDomain !== undefined && !/^[A-Za-z0-9.-]{1,255}$/.test(fromDomain)) {
        issues.push({ index, message: 'The sender domain filter is not a valid domain.' });
      }
      break;
    }
    case 'schedule': {
      if (!Array.isArray(draft.recurrences) || draft.recurrences.length === 0) {
        issues.push({ index, message: 'A schedule needs at least one rule.' });
      } else if (draft.recurrences.length > MAX_SCHEDULE_RULES) {
        issues.push({
          index,
          message: `A schedule can have at most ${MAX_SCHEDULE_RULES} rules.`,
        });
      } else {
        draft.recurrences.forEach((rule, at) => {
          if (!isRecurrence(rule)) {
            issues.push({ index, message: `Schedule rule ${at + 1} is incomplete.` });
          }
        });
      }
      if (!isValidTimezone(draft.timezone)) {
        issues.push({ index, message: 'The timezone is not recognized.' });
      }
      if (draft.startAt !== undefined && !isValidDateString(draft.startAt)) {
        issues.push({ index, message: 'The start date is not a valid date.' });
      }
      if (draft.calendarId !== undefined && draft.calendarId.length === 0) {
        issues.push({ index, message: 'Choose a holiday calendar, or none.' });
      }
      if (draft.blackouts !== undefined) {
        if (draft.blackouts.length > MAX_SCHEDULE_BLACKOUTS) {
          issues.push({
            index,
            message: `A schedule can carry at most ${MAX_SCHEDULE_BLACKOUTS} blackout entries.`,
          });
        } else if (!draft.blackouts.every(isBlackoutEntry)) {
          issues.push({
            index,
            message: 'A blackout entry is not a valid date, range, or annual date.',
          });
        }
      }
      if (
        draft.blackoutPolicy !== undefined &&
        !['skip', 'before', 'after'].includes(draft.blackoutPolicy)
      ) {
        issues.push({ index, message: 'The blackout policy must be skip, before, or after.' });
      }
      break;
    }
    case 'agent': {
      if (!UUID_PATTERN.test(draft.callerAgentId)) {
        issues.push({ index, message: 'Choose which agent should trigger this one.' });
      }
      break;
    }
    case 'api': {
      const seen = new Set<string>();
      for (const input of draft.inputs) {
        if (!VARIABLE_NAME_PATTERN.test(input.name)) {
          issues.push({
            index,
            message: `"${input.name}" is not a usable input name — start with a letter, then letters, numbers, - or _.`,
          });
        }
        if (seen.has(input.name)) {
          issues.push({ index, message: `Input "${input.name}" is listed twice.` });
        }
        seen.add(input.name);
      }
      break;
    }
  }
  return issues;
}

function isApiTriggerInput(value: unknown): value is ApiTriggerInput {
  if (typeof value !== 'object' || value === null) return false;
  const input: { name?: unknown; label?: unknown } = value;
  return typeof input.name === 'string' && typeof input.label === 'string';
}

export function isTriggerDraft(value: unknown): value is TriggerDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft: {
    kind?: unknown;
    eventId?: unknown;
    match?: unknown;
    recurrences?: unknown;
    timezone?: unknown;
    callerAgentId?: unknown;
    inputs?: unknown;
  } = value;
  switch (draft.kind) {
    case 'event':
      return typeof draft.eventId === 'string';
    case 'schedule':
      // Shape only (payload boundary); validateOne carries the field-level
      // messages. Optional members are checked there too.
      return (
        Array.isArray(draft.recurrences) &&
        draft.recurrences.every(isRecurrence) &&
        typeof draft.timezone === 'string'
      );
    case 'agent':
      return typeof draft.callerAgentId === 'string';
    case 'api':
      return Array.isArray(draft.inputs) && draft.inputs.every(isApiTriggerInput);
    default:
      return false;
  }
}

export function validateTriggerDrafts(drafts: TriggerDraft[]): TriggerIssue[] {
  return drafts.flatMap(validateOne);
}

/**
 * The `trigger.*` variable names the attached triggers provide — catalog
 * `provides` for events, author-named inputs for API triggers, the parent
 * run's summary for agent triggers, and fire time for schedules.
 */
export function triggerVariableNames(drafts: TriggerDraft[]): string[] {
  const names = new Set<string>();
  for (const draft of drafts) {
    switch (draft.kind) {
      case 'event': {
        for (const variable of triggerEventById(draft.eventId)?.provides ?? []) {
          names.add(variable.name);
        }
        break;
      }
      case 'api': {
        for (const input of draft.inputs) names.add(`trigger.${input.name}`);
        break;
      }
      case 'agent': {
        names.add('trigger.parentSummary');
        break;
      }
      case 'schedule': {
        names.add('trigger.scheduledFor');
        break;
      }
    }
  }
  return [...names];
}
