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
 */

import type { VariableDescriptor } from './variables';

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
}

const trigger = (name: string, label: string, description: string): VariableDescriptor => ({
  name: `trigger.${name}`,
  label,
  description,
  source: 'trigger',
});

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
        'messageId',
        'Message id',
        'The identifier of the triggering message; pass it to webex_get_message to fetch it.'
      ),
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
  },
  {
    id: 'zoom/meeting.summary_completed',
    source: 'zoom',
    type: 'meeting.summary_completed',
    connector: 'zoom',
    label: 'A meeting summary is ready',
    description:
      'Runs when Zoom AI Companion finishes the summary of a meeting you hosted.',
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
  },
];

export function triggerEventById(id: string): TriggerEventDescriptor | undefined {
  return TRIGGER_EVENT_CATALOG.find((event) => event.id === id);
}
