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
      trigger('messageId', 'Email id', 'The identifier tools can use to fetch the full email.'),
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
      trigger('roomId', 'Space id', 'The identifier of the space the message was posted in.'),
      trigger('messageId', 'Message id', 'The identifier tools can use to fetch the message.'),
    ],
  },
];

export function triggerEventById(id: string): TriggerEventDescriptor | undefined {
  return TRIGGER_EVENT_CATALOG.find((event) => event.id === id);
}
