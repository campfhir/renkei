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
import { triggerEventById, validateMatchForEvent } from './trigger-catalog';
import { isTriggerMatch, type TriggerMatch } from './trigger-filters';
import { VARIABLE_NAME_PATTERN } from './steps';
import type { VariableDescriptor } from './variables';

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
      /**
       * Deterministic narrowing, keyed by the event's filter field ids. The
       * shape is open because the fields are catalog data, not a type — see
       * `trigger-filters.ts` for the rules and `trigger-catalog.ts` for what
       * each event offers.
       */
      match?: TriggerMatch;
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
      // Field-level filter rules are catalog data, so the messages come from
      // there rather than from a check per field kept in step with it here.
      for (const message of validateMatchForEvent(draft.eventId, draft.match)) {
        issues.push({ index, message });
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
            message: `"${input.name}" is not a usable input name — start with a letter, then letters, numbers, spaces, ".", "-" or "_" (64 characters max).`,
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
      // `match` is checked structurally here, not field by field: this runs
      // on a wire payload, and letting an arbitrary object through as a
      // filter is how junk reaches the fan-out's hot path. validateOne
      // carries the field-level messages.
      return (
        typeof draft.eventId === 'string' &&
        (draft.match === undefined || isTriggerMatch(draft.match))
      );
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
 * The full `trigger.*` variable descriptors the attached triggers provide —
 * catalog `provides` for events, author-named inputs for API triggers, the
 * parent run's summary for agent triggers, and fire time for schedules.
 * Descriptions ride along so consumers (the drafting prompt, autocomplete)
 * can explain what each variable IS, not just that it exists.
 */
export function triggerVariableDescriptors(drafts: TriggerDraft[]): VariableDescriptor[] {
  const byName = new Map<string, VariableDescriptor>();
  const add = (descriptor: VariableDescriptor) => {
    if (!byName.has(descriptor.name)) byName.set(descriptor.name, descriptor);
  };
  for (const draft of drafts) {
    switch (draft.kind) {
      case 'event': {
        for (const variable of triggerEventById(draft.eventId)?.provides ?? []) {
          add(variable);
        }
        break;
      }
      case 'api': {
        for (const input of draft.inputs) {
          add({
            name: `trigger.${input.name}`,
            label: input.label,
            description: 'An input the caller supplies when starting this agent.',
            source: 'trigger',
          });
        }
        break;
      }
      case 'agent': {
        add({
          name: 'trigger.parentSummary',
          label: 'Parent run summary',
          description: "What the triggering agent's run concluded.",
          source: 'trigger',
        });
        break;
      }
      case 'schedule': {
        add({
          name: 'trigger.scheduledFor',
          label: 'Scheduled time',
          description: 'The ISO time this run was scheduled to start.',
          source: 'trigger',
        });
        break;
      }
    }
  }
  return [...byName.values()];
}

/** Just the names — kept in terms of the descriptors so the two can't drift. */
export function triggerVariableNames(drafts: TriggerDraft[]): string[] {
  return triggerVariableDescriptors(drafts).map((descriptor) => descriptor.name);
}
