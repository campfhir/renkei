/**
 * chat_widget_list / chat_widget_resolve — the model's hands on a preview
 * card's state, for when the person settles a card some other way.
 *
 * A preview tool (outlook_send_mail_preview, jira_create_issue_preview and
 * the rest) ends in a card with its own Send/Create and Discard/Cancel
 * buttons, and until now only those buttons could decide it: the receipt
 * every card renders once decided (mcp-widgets/src/ui.ts's DoneState) was
 * written by the card itself (widget-tools.ts's `recordWidgetDecision`,
 * off `ui/report-decision`). A person who sent the draft from Outlook
 * instead, or simply changed their mind without clicking Discard, was left
 * with a card offering live buttons for something already over — and the
 * model, asked to "mark that as sent", had nothing to reach for but the
 * feed's card_* tools, which know nothing of chat cards.
 *
 * `chat_widget_resolve` writes the same row the button would have
 * (`chat_widget_decisions`, keyed by the same `state_key` views.ts's
 * `widgetStateKeyOf` derives for the card), so everything downstream is
 * unchanged: the card renders the receipt on every device (chat-view.ts
 * stamps `resolved`; the turn's `widget_decided` event flips the card
 * already open), and the card's own confirm tool refuses to run afterwards
 * (`confirmWidgetTool`'s already-decided guard) — marking an email "sent
 * manually" also means the card can no longer send it a second time.
 * First decision wins, the same as between two devices: a card the person
 * decided from its buttons in the meantime is reported, not overwritten.
 *
 * It records; it never acts. Nothing is sent, created or discarded on any
 * system by this tool, and the description says so — the model's word for
 * what happened outside Renkei is what the receipt shows.
 *
 * `chat_widget_list` is how the model finds the card the person means:
 * every decidable card in this chat, oldest first, with the id to address
 * it by (the `previewId` or `draftId` of its structuredContent — the part
 * of the state key that is the card's own) and whether it is still
 * awaiting a decision.
 */

import { listMessages, type StoredMessage } from './messages';
import { toChatBlocks, widgetStateKeyOf, type WidgetDecisionState } from './views';
import { getWidgetDecision, listWidgetDecisions, recordWidgetDecision } from './widget-tools';
import { errorResult, textResult, type LocalTool } from './local-tools';

const MAX_HEADLINE_CHARS = 120;
const MAX_DETAIL_CHARS = 300;

export const WIDGET_LIST_TOOL = 'chat_widget_list';
export const WIDGET_RESOLVE_TOOL = 'chat_widget_resolve';

/** One decidable preview card in a chat, as the tools see it. */
export interface WidgetCard {
  /** What the model addresses the card by: its previewId or draftId. */
  id: string;
  /** The card's persistence key (`chat_widget_decisions.state_key`). */
  stateKey: string;
  /** The preview tool that produced it. */
  toolName: string;
  toolUseId: string;
  /** What the card is about, off its structuredContent; the tool name when it says nothing. */
  title: string;
  /** A second line where the payload has one (a subtitle, the recipients). */
  detail: string;
  /** The receipt already recorded for it, if any. */
  resolved: WidgetDecisionState | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Every decidable card among a chat's rows, oldest first: a `tool_result`
 * block bound to a widget (`uiResourceUri`) whose payload carries a
 * previewId or draftId — the same test chat-view.ts and widget-tools.ts
 * apply, through `widgetStateKeyOf`. A display-only card (a results list)
 * has no key and is not listed: there is nothing to decide on it.
 */
export function widgetCardsOf(
  messages: StoredMessage[],
  decisions: ReadonlyMap<string, WidgetDecisionState>
): WidgetCard[] {
  const toolNames = new Map<string, string>();
  const cards: WidgetCard[] = [];
  for (const row of messages) {
    for (const block of toChatBlocks(row.blocks)) {
      if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
        continue;
      }
      if (block.type !== 'tool_result') continue;
      const stateKey = widgetStateKeyOf(block);
      if (!stateKey) continue;
      const payload: Record<string, unknown> =
        typeof block.structuredContent === 'object' && block.structuredContent !== null
          ? { ...block.structuredContent }
          : {};
      const toolName = toolNames.get(block.toolUseId) ?? '(unknown tool)';
      const recipients = strings(payload.to);
      cards.push({
        id: stateKey.slice(stateKey.indexOf(':') + 1),
        stateKey,
        toolName,
        toolUseId: block.toolUseId,
        title:
          str(payload.title) ||
          str(payload.subject) ||
          str(payload.topic) ||
          str(payload.action) ||
          toolName,
        detail:
          str(payload.subtitle) ||
          (recipients.length > 0 ? `to ${recipients.join(', ')}` : '') ||
          str(payload.roomTitle) ||
          str(payload.toPersonEmail),
        resolved: decisions.get(stateKey) ?? null,
      });
    }
  }
  return cards;
}

/** The card the model named: by its own id, or by the whole state key. */
export function findWidgetCard(cards: WidgetCard[], widget: string): WidgetCard | null {
  const wanted = widget.trim();
  if (!wanted) return null;
  return cards.find((card) => card.id === wanted || card.stateKey === wanted) ?? null;
}

function cardLine(card: WidgetCard): string {
  const state = card.resolved
    ? `decided — ${card.resolved.headline}${card.resolved.detail ? ` (${card.resolved.detail})` : ''}`
    : 'awaiting the person’s decision';
  return (
    `- ${card.title}${card.detail ? ` — ${card.detail}` : ''} (${card.toolName}) · ${state}\n` +
    `  widget: ${card.id}`
  );
}

export function widgetStateTools(): LocalTool[] {
  return [
    {
      readOnly: true,
      def: {
        name: WIDGET_LIST_TOOL,
        description:
          'List the preview cards in this chat — every email, message, meeting, issue or ' +
          'directory-action preview the person was shown to confirm or discard — oldest ' +
          'first, with the id to address each by and whether it is still awaiting their ' +
          'decision or already decided (and how). Use it to find the card the person means ' +
          'before chat_widget_resolve. These are the chat’s inline cards, not the Renkei feed ' +
          '(card_list is the feed).',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute(_input, context) {
        const messages = await listMessages(
          context.db,
          context.chatId,
          context.cipher
        );
        const decisions = await listWidgetDecisions(context.db, context.chatId);
        const cards = widgetCardsOf(messages, decisions);
        if (cards.length === 0) return textResult('No preview cards in this chat.');
        const pending = cards.filter((card) => !card.resolved).length;
        return textResult(
          [
            `${cards.length} preview card(s) in this chat, ${pending} awaiting a decision:`,
            '',
            ...cards.map(cardLine),
          ].join('\n')
        );
      },
    },
    {
      def: {
        name: WIDGET_RESOLVE_TOOL,
        description:
          'Mark a preview card in this chat as decided when the person settled it some other ' +
          'way — sent the email from Outlook themselves, created the issue by hand, or no ' +
          'longer wants it — so the card shows a receipt instead of its Send/Confirm and ' +
          'Discard/Cancel buttons, on every device, and can no longer be confirmed from the ' +
          'card. This only records the outcome: it sends, creates or discards NOTHING on any ' +
          'system. Use it when asked to (“mark that as sent”, “I already did that”, “discard ' +
          'the card”), never to decide a card for the person. Find the card’s id with ' +
          'chat_widget_list. A card already decided is left as it is.',
        inputSchema: {
          type: 'object',
          properties: {
            widget: {
              type: 'string',
              description: 'The card’s id, as chat_widget_list shows it.',
            },
            outcome: {
              type: 'string',
              enum: ['done', 'cancelled'],
              description:
                '"done": the thing the card previewed happened, outside the card (sent, ' +
                'created, applied). "cancelled": it will not happen; the card is discarded.',
            },
            headline: {
              type: 'string',
              description:
                `The receipt’s one line, at most ${MAX_HEADLINE_CHARS} characters — say what ` +
                'actually happened, e.g. "Sent manually from Outlook" or "Discarded". ' +
                'Default: "Done" or "Cancelled".',
            },
            detail: {
              type: 'string',
              description: `An optional second line, at most ${MAX_DETAIL_CHARS} characters (who it went to, why it was dropped).`,
            },
          },
          required: ['widget', 'outcome'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const widget = str(input.widget);
        if (!widget)
          return errorResult('`widget` is required: the card’s id from chat_widget_list.');
        const outcome = input.outcome;
        if (outcome !== 'done' && outcome !== 'cancelled') {
          return errorResult('`outcome` must be "done" or "cancelled".');
        }
        const headline =
          str(input.headline).slice(0, MAX_HEADLINE_CHARS) ||
          (outcome === 'done' ? 'Done' : 'Cancelled');
        const detail = str(input.detail).slice(0, MAX_DETAIL_CHARS);

        const messages = await listMessages(
          context.db,
          context.chatId,
          context.cipher
        );
        const decisions = await listWidgetDecisions(context.db, context.chatId);
        const card = findWidgetCard(widgetCardsOf(messages, decisions), widget);
        if (!card) {
          return errorResult(
            `No preview card "${widget}" in this chat. chat_widget_list shows the cards and their ids.`
          );
        }
        if (card.resolved) {
          return errorResult(
            `"${card.title}" is already decided: ${card.resolved.headline}. Nothing changed.`
          );
        }

        const state: WidgetDecisionState = {
          icon: outcome === 'done' ? 'sent' : 'cancelled',
          headline,
          ...(detail ? { detail } : {}),
        };
        const recorded = await recordWidgetDecision(context.db, {
          chatId: context.chatId,
          subject: context.subject,
          stateKey: card.stateKey,
          decision: outcome === 'done' ? 'confirmed' : 'cancelled',
          state,
        });
        if (!recorded.ok) return errorResult('The card could not be marked.');
        // First decision wins (recordWidgetDecision's ON CONFLICT DO NOTHING):
        // a button click on another device that landed between the read
        // above and this write is the receipt now, and the model should
        // say so rather than report its own wording as what the card shows.
        const now = await getWidgetDecision(context.db, card.stateKey);
        if (!now) return errorResult('The card could not be marked.');
        if (now.icon !== state.icon || now.headline !== state.headline) {
          return errorResult(
            `"${card.title}" was decided from the card in the meantime: ${now.headline}. Nothing changed.`
          );
        }
        context.emitWidgetDecision?.({ stateKey: card.stateKey, state: now });
        return textResult(
          `Marked "${card.title}" as ${outcome}: ${headline}${detail ? ` — ${detail}` : ''}. ` +
            'The card now shows this receipt instead of its buttons, and its own action can no ' +
            'longer be run from it. Nothing was sent, created or discarded by this call.'
        );
      },
    },
  ];
}
