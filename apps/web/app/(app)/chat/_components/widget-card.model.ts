/**
 * The host half of the MCP Apps protocol (SEP-1865) a preview card speaks
 * to its chat (widget-card.tsx), with no frame, no network and no React:
 * given one message the card sent, what the host does about it — the
 * replies it posts back into the frame, and the calls it makes on the
 * card's behalf (the confirm tool, the decision, the model's note, a
 * link, a new height). The component checks the message came from its own
 * frame, carries the effects out in order, and answers a tool call with
 * `toolCallReply` once the server has. Tested in widget-card.model.test.ts.
 */

import { recordOrNull } from '@renkei/guards';
import type { ChatBlock, WidgetDecisionState } from '@/lib/chat/views';

export type ToolResultBlock = Extract<ChatBlock, { type: 'tool_result' }>;

/** A JSON-RPC message for the frame; the component adds `jsonrpc: '2.0'` as it posts. */
export type Outgoing = Record<string, unknown>;

export const MIN_HEIGHT = 48;
export const MAX_HEIGHT = 2000;
/** The frame's height before the card has measured itself. */
export const DEFAULT_HEIGHT = 96;

/** What the host does about one message from its card, in order. */
export type HostEffect =
  /** Post a reply or notification into the card's frame. */
  | { type: 'post'; message: Outgoing }
  /** The card finished its handshake: a later `resolved` can be pushed to it from now on. */
  | { type: 'initialized' }
  /** Run the card's confirm tool on the server; answer request `id` with `toolCallReply`. */
  | {
      type: 'call-tool';
      id: unknown;
      name: string;
      args: Record<string, unknown>;
      stateKey: string | undefined;
    }
  /** Record the card's decision, so a reload or another device shows the receipt. */
  | {
      type: 'report-decision';
      stateKey: string;
      decision: 'confirmed' | 'cancelled';
      state: WidgetDecisionState;
    }
  /** Open a link the card asked for, in a new tab. */
  | { type: 'open-link'; url: string }
  /** Hand the server what the person did on the card: a note, and the model's turn on it. */
  | { type: 'model-context'; text: string; stateKey: string | undefined }
  /** Size the frame to the card. */
  | { type: 'resize'; height: number };

/** What the host knows when a message arrives. */
export interface HostContext {
  /** The page's theme right now, handed to the card at its handshake. */
  theme: 'light' | 'dark';
  /** The arguments the tool was called with. */
  toolInput: unknown;
  /** The tool_result block the call finished with. */
  result: ToolResultBlock;
}

function textContentOf(content: string): { type: string; text: string }[] {
  return content ? [{ type: 'text', text: content }] : [];
}

/** The text of an `ui/update-model-context` call's `content` param: its text blocks, one per line. */
export function joinedText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      const entry = recordOrNull(block);
      return entry?.type === 'text' && typeof entry.text === 'string' ? [entry.text] : [];
    })
    .join('\n');
}

/**
 * The tool-result notification for a block. A decision recorded for the
 * card (`resolved`) rides inside its structuredContent, where every card
 * reads it on render and shows its receipt instead of live buttons.
 */
export function toolResultNotification(block: ToolResultBlock): Outgoing {
  return {
    method: 'ui/notifications/tool-result',
    params: {
      isError: block.isError === true,
      content: textContentOf(block.content),
      ...('structuredContent' in block
        ? {
            structuredContent: block.resolved
              ? { ...recordOrNull(block.structuredContent), resolved: block.resolved }
              : block.structuredContent,
          }
        : {}),
    },
  };
}

/**
 * What a later change to the block has to match for the card to be told
 * again: the decision's content, not the block's identity — a re-render
 * that leaves the decision as it was posts nothing. Null with no decision.
 */
export function resolvedKeyOf(block: ToolResultBlock): string | null {
  return block.resolved ? JSON.stringify(block.resolved) : null;
}

/** The frame's height for a size the card reported, or null to leave it as it is. */
export function clampHeight(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(raw)));
}

/** A receipt with the sent tick is a confirmation; anything else the card finished on is a cancel. */
export function decisionOf(state: Record<string, unknown>): 'confirmed' | 'cancelled' {
  return state.icon === 'sent' ? 'confirmed' : 'cancelled';
}

/** The answer to a card's `tools/call`, once the server has given one. */
export function toolCallReply(
  id: unknown,
  answer: { data: { result: unknown } | null; error: string | null }
): Outgoing {
  if (answer.error || !answer.data) {
    return {
      id,
      error: { code: -32000, message: answer.error ?? 'The tool could not be reached.' },
    };
  }
  return { id, result: answer.data.result };
}

const stringOr = <T>(value: unknown, fallback: T): string | T =>
  typeof value === 'string' ? value : fallback;

/**
 * Everything the host does about one message from its card. Anything
 * that is not JSON-RPC 2.0, a method this host does not speak, or a
 * request that needs an answer but carries no id, does nothing.
 */
export function hostEffects(message: unknown, context: HostContext): HostEffect[] {
  const rpc = recordOrNull(message);
  if (rpc?.jsonrpc !== '2.0') return [];
  // Any id the card sent is echoed back as it came; only a missing one means no answer is owed.
  const id = rpc.id;
  const params = recordOrNull(rpc.params);

  switch (rpc.method) {
    case 'ui/initialize':
      if (id === undefined) return [];
      return [{ type: 'post', message: { id, result: { hostContext: { theme: context.theme } } } }];
    case 'ui/notifications/initialized':
      return [
        { type: 'initialized' },
        {
          type: 'post',
          message: {
            method: 'ui/notifications/tool-input',
            params: { arguments: context.toolInput ?? {} },
          },
        },
        { type: 'post', message: toolResultNotification(context.result) },
      ];
    case 'tools/call':
      if (id === undefined) return [];
      return [
        {
          type: 'call-tool',
          id,
          name: stringOr(params?.name, ''),
          args: recordOrNull(params?.arguments) ?? {},
          stateKey: stringOr(params?.stateKey, undefined),
        },
      ];
    case 'ui/report-decision': {
      if (id === undefined) return [];
      const reply: HostEffect = { type: 'post', message: { id, result: {} } };
      const stateKey = stringOr(params?.stateKey, '');
      const state = recordOrNull(params?.state);
      // Best-effort, same as ui/update-model-context: a dropped request
      // costs cross-device sync, never the decision itself, which the
      // card already rendered locally before sending this.
      if (!stateKey || !state) return [reply];
      return [
        reply,
        {
          type: 'report-decision',
          stateKey,
          decision: decisionOf(state),
          // The server checks the receipt's shape before it records it
          // (widget/decision/route.ts); the host passes it on as sent.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          state: state as unknown as WidgetDecisionState,
        },
      ];
    }
    case 'ui/open-link': {
      if (id === undefined) return [];
      const url = stringOr(params?.url, '');
      const reply: HostEffect = { type: 'post', message: { id, result: {} } };
      return url ? [reply, { type: 'open-link', url }] : [reply];
    }
    case 'ui/update-model-context': {
      if (id === undefined) return [];
      const reply: HostEffect = { type: 'post', message: { id, result: {} } };
      const text = joinedText(params?.content);
      // A card that said nothing has nothing for the model.
      if (!text) return [reply];
      return [
        reply,
        { type: 'model-context', text, stateKey: stringOr(params?.stateKey, undefined) },
      ];
    }
    case 'ui/notifications/size-changed': {
      const height = clampHeight(params?.height);
      return height === null ? [] : [{ type: 'resize', height }];
    }
    default:
      return [];
  }
}
