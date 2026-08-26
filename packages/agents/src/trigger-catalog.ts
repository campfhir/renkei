/**
 * The connector events an agent can be triggered by — the contract between
 * the builder (which offers them by name) and the worker (which emits them
 * from its pipeline call sites).
 *
 * Deliberately tiny and curated: an entry here is a promise that a call
 * site in the interactive worker actually emits it. Adding an event means
 * adding both — the catalog row for the builder and the
 * `fanOutAgentEvents(...)` call where the pipeline sees the thing happen.
 *
 * `provides` is the trigger's contribution to the variable namespace: the
 * `trigger.*` chips a step can reference when this trigger is attached.
 * The fan-out call site must put exactly these keys (under `trigger.`-less
 * names) into the run's initial_state.
 *
 * `filters` is the deterministic narrowing a person may apply to the event
 * before any run exists — and because a filter compares a payload key, the
 * two lists are bound: a filter's `payloadKey` must be one of that entry's
 * `provides` names minus the `trigger.` prefix. Adding a connector's
 * filters is entries here, never a branch in the matcher.
 */

import type { VariableDescriptor } from './variables';
import {
  DOMAIN_PATTERN,
  EMAIL_PATTERN,
  describeFilters,
  isEmptyMatch,
  matchesFilters,
  normalizeMatch,
  validateMatch,
  type TriggerFilterField,
  type TriggerMatch,
} from './trigger-filters';

export interface TriggerEventDescriptor {
  /** `${source}/${type}` — the id stored on drafts and matched at fan-out. */
  id: string;
  /** Queue-source namespace the emitting call site uses. */
  source: string;
  type: string;
  /** Connector catalog key, for grouping and logos in the builder. */
  connector: string;
  label: string;
  description: string;
  provides: VariableDescriptor[];
  /** Deterministic narrowing offered for this event; [] means none yet. */
  filters: TriggerFilterField[];
}

const trigger = (name: string, label: string, description: string): VariableDescriptor => ({
  name: `trigger.${name}`,
  label,
  description,
  source: 'trigger',
});

/**
 * A list of exact addresses. Shared because "only from these people" reads
 * the same whether the address came from a mailbox, a WebEx space or a Zoom
 * host — only the payload key and the wording differ.
 */
const addressList = (
  id: string,
  payloadKey: string,
  label: string,
  hint: string,
  one: string,
  many: string
): TriggerFilterField => ({
  id,
  payloadKey,
  match: 'equals-any',
  input: 'text-list',
  label,
  hint,
  placeholder: 'name@company.com',
  maxEntries: 25,
  pattern: EMAIL_PATTERN,
  invalidMessage: `${label} takes email addresses`,
  // A search, not a source: colleagues are worth not having to spell, but
  // plenty of addresses worth filtering on — a customer, a vendor, an
  // alias — are in nobody's directory. Typed values are always accepted.
  suggest: 'microsoft-people',
  describeOne: one,
  describeMany: many,
});

/** A case-insensitive substring of a title-ish payload field. */
const containsField = (
  id: string,
  payloadKey: string,
  label: string,
  hint: string,
  one: string
): TriggerFilterField => ({
  id,
  payloadKey,
  match: 'contains',
  input: 'text',
  label,
  hint,
  maxLength: 200,
  invalidMessage: `${label} is not usable`,
  describeOne: one,
});

// Both Zoom events carry the same host and topic, so they filter alike.
const zoomHostEmails = addressList(
  'hostEmails',
  'hostEmail',
  'Only these hosts',
  'Exact addresses. Useful when you host on behalf of several teams.',
  'hosted by {value}',
  'hosted by any of {count} people'
);

const zoomTopicContains = containsField(
  'topicContains',
  'topic',
  'Meeting title contains',
  'Case-insensitive. Matches anywhere in the meeting title.',
  'the meeting title contains "{value}"'
);

export const TRIGGER_EVENT_CATALOG: TriggerEventDescriptor[] = [
  {
    id: 'microsoft/mail.received',
    source: 'microsoft',
    type: 'mail.received',
    connector: 'microsoft',
    label: 'An email arrives',
    description: 'Runs when a new email lands in your own inbox.',
    provides: [
      trigger('subject', 'Email subject', 'The subject line of the email that triggered this run.'),
      trigger('body', 'Email body', 'A text preview of the email that triggered this run.'),
      trigger('from', 'Sender', 'The address the triggering email came from.'),
      trigger(
        'messageId',
        'Email id',
        'The identifier of the triggering email; pass it to outlook_get_message to read the full email or to outlook_reply_preview to answer it.'
      ),
    ],
    filters: [
      addressList(
        'fromAddresses',
        'from',
        'From these senders',
        'Exact addresses. The directory can help you find people, but you can type any address.',
        'from {value}',
        'from any of {count} senders'
      ),
      {
        // Id and regex are the ones that shipped with the original filter,
        // kept verbatim so every saved trigger keeps working untouched.
        id: 'fromDomain',
        payloadKey: 'from',
        match: 'address-domain',
        input: 'text',
        label: 'From this domain',
        hint: 'Everyone at one company, e.g. customer.example.',
        placeholder: 'customer.example',
        pattern: DOMAIN_PATTERN,
        invalidMessage: 'The sender domain filter is not a valid domain.',
        describeOne: 'from anyone at {value}',
      },
      containsField(
        'subjectContains',
        'subject',
        'Subject contains',
        'Case-insensitive. Matches anywhere in the subject line.',
        'the subject contains "{value}"'
      ),
    ],
  },
  {
    id: 'webex/message.received',
    source: 'webex',
    type: 'message.received',
    connector: 'webex',
    label: 'A message is posted',
    description: 'Runs when a message is posted in a WebEx space you belong to.',
    provides: [
      trigger('text', 'Message text', 'The text of the message that triggered this run.'),
      trigger('sender', 'Sender', 'Who posted the triggering message.'),
      trigger(
        'roomId',
        'Space id',
        'The identifier of the space the message was posted in; pass it to webex_send_message to reply in that space.'
      ),
      trigger(
        'roomType',
        'Space type',
        'Where the message was posted: "direct" for a one-to-one conversation, "group" for a group space.'
      ),
      trigger(
        'messageId',
        'Message id',
        'The identifier of the triggering message; pass it to webex_get_message to fetch it.'
      ),
    ],
    filters: [
      {
        // One field rather than an include/exclude pair: WebEx has exactly
        // two room types, so "only direct messages" and "keep direct
        // messages out" are the same choice seen from opposite ends.
        id: 'spaceType',
        payloadKey: 'roomType',
        match: 'equals-any',
        input: 'select',
        label: 'Direct messages',
        hint: 'Watch only one-to-one (direct) messages, keep them out, or take both.',
        invalidMessage: 'The space-type filter must be "direct" or "group".',
        options: [
          { value: '', label: 'Direct and group', describe: '' },
          { value: 'direct', label: 'Direct messages only', describe: 'in a direct message' },
          {
            value: 'group',
            label: 'Group spaces only',
            describe: 'in a group space, never a direct message',
          },
        ],
        describeOne: 'in a {value} conversation',
      },
      {
        id: 'roomIds',
        payloadKey: 'roomId',
        match: 'id-equals-any',
        input: 'picker-list',
        label: 'Only these spaces',
        hint: 'Pick from your spaces, or paste a space id. Spaces with no recent activity may not be listed.',
        maxEntries: 25,
        // No pattern: a WebEx room id is base64 of a URN and its alphabet
        // is the provider's business, not ours to police.
        invalidMessage: 'That does not look like a space id.',
        picker: 'webex-rooms',
        describeOne: 'in 1 chosen space',
        describeMany: 'in {count} chosen spaces',
      },
      {
        // The mirror of roomIds. Both can be set: "only these ten spaces,
        // except the noisy one" is a real thing to want, and since fields
        // AND together it already reads correctly with no special case.
        id: 'exceptRoomIds',
        payloadKey: 'roomId',
        match: 'id-equals-any',
        input: 'picker-list',
        label: 'Except these spaces',
        hint: 'Messages in these spaces never wake this agent, whatever the other filters say.',
        maxEntries: 25,
        invalidMessage: 'That does not look like a space id.',
        picker: 'webex-rooms',
        negate: true,
        describeOne: 'but not in 1 chosen space',
        describeMany: 'but not in {count} chosen spaces',
      },
      addressList(
        'senderAddresses',
        'sender',
        'Only from these people',
        'Exact addresses of the people whose messages should wake this agent.',
        'posted by {value}',
        'posted by any of {count} people'
      ),
      {
        // Named separately from senderAddresses rather than sharing a
        // field with a toggle: the two compose, and the commonest use is
        // "everyone except the build bot", which needs no positive list at
        // all.
        id: 'exceptSenderAddresses',
        payloadKey: 'sender',
        match: 'equals-any',
        input: 'text-list',
        label: 'Except from these people',
        hint: 'Exact addresses to ignore — a noisy integration account, or yourself.',
        placeholder: 'builds@example.com',
        maxEntries: 25,
        pattern: EMAIL_PATTERN,
        invalidMessage: 'That is not an address this filter can use.',
        suggest: 'microsoft-people',
        negate: true,
        describeOne: 'but not from {value}',
        describeMany: 'but not from {count} people',
      },
      {
        // The message text really is the message, unlike mail's body, which
        // reaches the fan-out as Outlook's short preview — which is why this
        // filter exists on WebEx and not there. Long messages are still
        // truncated to BODY_PREVIEW_CHARS before the event is published, so
        // a keyword past ~1000 characters will not be seen; the hint says so
        // rather than leaving a silently-never-firing agent to explain.
        id: 'textKeywords',
        payloadKey: 'text',
        match: 'contains',
        input: 'text-list',
        label: 'Mentions these keywords',
        hint: 'Case-insensitive, matched anywhere in the message. Very long messages are only matched over their first ~1000 characters.',
        placeholder: 'deploy',
        maxEntries: 25,
        maxLength: 100,
        // No pattern: a keyword is whatever somebody types, punctuation and
        // spaces included — "on call" is a legitimate phrase to watch for.
        invalidMessage: 'That keyword cannot be used.',
        modeKey: 'textKeywordsMode',
        describeOne: 'mentioning "{value}"',
        describeMany: 'mentioning any of {count} keywords',
        describeAll: 'mentioning all {count} keywords',
      },
    ],
  },
  {
    id: 'zoom/recording.transcript_completed',
    source: 'zoom',
    type: 'recording.transcript_completed',
    connector: 'zoom',
    label: 'A meeting transcript is ready',
    description:
      'Runs when a Zoom meeting you hosted finishes processing its recording transcript.',
    provides: [
      trigger('meetingId', 'Meeting id', 'The numeric id of the Zoom meeting.'),
      trigger(
        'meetingUuid',
        'Meeting uuid',
        'The uuid of the exact meeting occurrence; pass it to zoom_get_transcript.'
      ),
      trigger('topic', 'Meeting topic', 'The topic (title) of the meeting.'),
      trigger('hostEmail', 'Host email', 'The email address of the meeting host.'),
      trigger('startTime', 'Start time', 'When the meeting started (ISO timestamp).'),
      trigger(
        'transcriptPreview',
        'Transcript preview',
        'The first part of the transcript text; pass the meeting uuid to zoom_get_transcript for the full text.'
      ),
    ],
    filters: [zoomHostEmails, zoomTopicContains],
  },
  {
    id: 'zoom/meeting.summary_completed',
    source: 'zoom',
    type: 'meeting.summary_completed',
    connector: 'zoom',
    label: 'A meeting summary is ready',
    description: 'Runs when Zoom AI Companion finishes the summary of a meeting you hosted.',
    provides: [
      trigger('meetingId', 'Meeting id', 'The numeric id of the Zoom meeting.'),
      trigger('meetingUuid', 'Meeting uuid', 'The uuid of the exact meeting occurrence.'),
      trigger('topic', 'Meeting topic', 'The topic (title) of the meeting.'),
      trigger('hostEmail', 'Host email', 'The email address of the meeting host.'),
      trigger('startTime', 'Start time', 'When the meeting started (ISO timestamp).'),
      trigger(
        'summaryPreview',
        'Summary preview',
        'The first part of the summary text; pass the meeting id to zoom_get_meeting_summary for the full summary.'
      ),
    ],
    filters: [zoomHostEmails, zoomTopicContains],
  },
];

export function triggerEventById(id: string): TriggerEventDescriptor | undefined {
  return TRIGGER_EVENT_CATALOG.find((event) => event.id === id);
}

/**
 * The filter fields an event offers. An unknown event id yields none, which
 * makes every wrapper below degrade to "no filters" rather than throw — see
 * the fail-open note in `trigger-filters.ts`.
 */
export function triggerFilterFields(eventId: string): TriggerFilterField[] {
  return triggerEventById(eventId)?.filters ?? [];
}

/**
 * The event-id-shaped wrappers. They live here rather than in
 * `trigger-filters.ts` because that module must not import this one — the
 * catalog depends on the filter TYPES, so the dependency can only run one
 * way. Callers that hold an event id use these; callers that already hold a
 * field list use the primitives directly.
 */
export function normalizeMatchForEvent(eventId: string, raw: unknown): TriggerMatch {
  return normalizeMatch(triggerFilterFields(eventId), raw);
}

export function validateMatchForEvent(eventId: string, raw: unknown): string[] {
  return validateMatch(triggerFilterFields(eventId), raw);
}

/**
 * The one call the fan-out makes. `eventId` is `${source}/${type}`, which
 * is what `agent_triggers` denormalizes into its indexed columns.
 */
export function matchesTriggerEvent(
  eventId: string,
  match: unknown,
  payload: Record<string, unknown>
): boolean {
  return matchesFilters(triggerFilterFields(eventId), match, payload);
}

export function describeTriggerMatch(eventId: string, match: unknown): string | null {
  return describeFilters(triggerFilterFields(eventId), match);
}

export function isEmptyTriggerMatch(eventId: string, match: unknown): boolean {
  return isEmptyMatch(triggerFilterFields(eventId), match);
}
