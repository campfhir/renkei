/**
 * One-line, human-readable answers to "when does this agent run?" — shared
 * by the agents list (badges) and the agent overview page (trigger rows).
 * Server-safe on purpose: the overview page is a server component, so the
 * builder's client-side summaries cannot be imported there.
 */

import { describeSchedule, triggerEventById, type TriggerDraft } from '@renkei/agents';

/** Short badge text for a trigger kind. */
export function triggerBadge(kind: string): string {
  switch (kind) {
    case 'event':
      return 'On an event';
    case 'schedule':
      return 'Scheduled';
    case 'agent':
      return 'After an agent';
    case 'api':
      return 'API';
    default:
      return kind;
  }
}

/** One sentence describing when a specific trigger fires. */
export function triggerSummary(draft: TriggerDraft): string {
  switch (draft.kind) {
    case 'event':
      return triggerEventById(draft.eventId)?.label ?? draft.eventId;
    case 'schedule':
      return describeSchedule(draft);
    case 'agent':
      return 'After another agent finishes';
    case 'api':
      return 'From an API call';
  }
}
