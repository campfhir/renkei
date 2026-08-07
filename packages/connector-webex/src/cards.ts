/**
 * Adaptive Cards for forward-to-Renkei (RENKEI.md use case #3).
 *
 * The interaction lives in the WebEx client: when the bot is mentioned and
 * ambient classification did not capture anything, it replies with this
 * card, and the "Push to Renkei" button deliberately ingests the message —
 * a human saying "this matters" overrides any heuristic. Renkei is the
 * receiver; nothing here asks the user to leave WebEx.
 *
 * A pressed Action.Submit arrives as an attachmentActions webhook whose
 * substance the worker RE-FETCHES from the WebEx API before acting — the
 * card's `data` payload carries routing only (which message to capture,
 * where to reply); the actor's identity comes from the fetched action.
 */

export const CARD_COMMAND_PUSH = 'push_to_renkei';

/** The card input id whose value carries the pusher's optional note. */
export const CARD_INPUT_NOTE = 'note';

export interface PushCardInput {
  /** The message the button will push into Renkei. */
  messageId: string;
  /** Thread root the capture confirmation should land under (cosmetic). */
  replyTo?: string;
}

/** The attachment shape the create-message API expects. */
export interface CardAttachment {
  contentType: 'application/vnd.microsoft.card.adaptive';
  content: Record<string, unknown>;
}

export function buildPushToRenkeiCard(input: PushCardInput): CardAttachment {
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.3',
      body: [
        {
          type: 'TextBlock',
          text: 'Push this to Renkei?',
          weight: 'Bolder',
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: 'Renkei will capture this message as an actionable item — with related context from your connected tools — for review and one-click follow-up.',
          wrap: true,
          isSubtle: true,
          size: 'Small',
        },
        {
          type: 'Input.Text',
          id: CARD_INPUT_NOTE,
          placeholder: 'Optional note for context',
          isMultiline: true,
        },
      ],
      actions: [
        {
          type: 'Action.Submit',
          title: 'Push to Renkei',
          data: {
            command: CARD_COMMAND_PUSH,
            messageId: input.messageId,
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          },
        },
      ],
    },
  };
}

export interface ParsedPushAction {
  messageId: string;
  note: string | null;
  replyTo: string | null;
}

/**
 * Narrow a fetched attachment action's inputs to the push card's contract.
 * Returns null for anything that is not this card's action.
 */
export function parsePushAction(inputs: Record<string, unknown>): ParsedPushAction | null {
  if (inputs.command !== CARD_COMMAND_PUSH) return null;

  const messageId = inputs.messageId;
  if (typeof messageId !== 'string' || messageId.length === 0) return null;

  const note = inputs[CARD_INPUT_NOTE];
  const replyTo = inputs.replyTo;

  return {
    messageId,
    note: typeof note === 'string' && note.trim() ? note.trim() : null,
    replyTo: typeof replyTo === 'string' && replyTo ? replyTo : null,
  };
}
