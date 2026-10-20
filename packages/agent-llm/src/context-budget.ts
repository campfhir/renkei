/**
 * Keeping one model request inside the model's context window.
 *
 * A conversation that only grows — an agent run's turns, one chat turn's
 * rounds of tool calls — eventually outgrows any model. Summarizing old
 * history is the caller's job (it needs a model call and somewhere to
 * keep the summary: apps/worker-agents' run compaction, the chat's
 * compaction.ts). What this module guarantees is the last line: whatever
 * history the caller hands it, the request it sends FITS — including when
 * a single recent turn is itself too big (a dozen 30 000-character reads,
 * one batch report), which no between-turns summary can fix.
 *
 * Nothing here drops a message or a block: alternation and every
 * tool_use/tool_result pair stay as they were, so the provider accepts the
 * result. What shrinks, in order, until the request fits:
 *   1. old tool results (outside the recent window) — to a short head;
 *   2. old tool-call inputs and old assistant text that are large — to a
 *      placeholder / head;
 *   3. the recent window's largest tool results — to a head and tail, the
 *      cut said in place;
 *   4. the recent window's largest remaining text — the same way.
 * Thinking blocks are never edited (their signature attests to their
 * text), only counted. Each cut says what was cut and how to get it back,
 * so the model knows a result is partial rather than reading it as whole.
 *
 * Sizes are in characters, converted from tokens conservatively — a
 * request that fits by this count fits by the provider's.
 */

import type { LlmContentBlock, LlmMessage } from './contract';

/** Characters per token, on the safe side (English prose runs nearer 4). */
export const CHARS_PER_TOKEN = 3;
/** The window assumed for a model nothing better is known about. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/** No budget is ever set below this: a model too small for it is not usable for tools. */
export const MIN_TRANSCRIPT_CHARS = 40_000;
/** What an old result keeps of itself (step 1). */
const OLD_RESULT_HEAD_CHARS = 600;
/** An old tool input or assistant text above this is cut (step 2). */
const OLD_BLOCK_MAX_CHARS = 2_000;
/** A recent block is never cut below this (steps 3 and 4). */
const RECENT_BLOCK_MIN_CHARS = 2_000;
/** Messages at the end that count as "recent": the last three exchanges. */
export const RECENT_MESSAGES = 6;

/**
 * The model's context window, in tokens: what the operator recorded on the
 * model (`settings.contextWindow`, the admin model form), else what the
 * model family is known to take, else a conservative default.
 */
export function contextWindowOf(model: string, settings?: unknown): number {
  if (typeof settings === 'object' && settings !== null && !Array.isArray(settings)) {
    const configured: unknown = Reflect.get(settings, 'contextWindow');
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
  }
  const name = model.toLowerCase();
  if (/\[1m\]|-1m\b/.test(name)) return 1_000_000;
  if (name.includes('claude')) return 200_000;
  if (/gpt-4\.1|gemini/.test(name)) return 1_000_000;
  if (/gpt-5/.test(name)) return 400_000;
  if (/\bo[134](-|$)/.test(name)) return 200_000;
  if (/gpt-4o|gpt-4-turbo/.test(name)) return 128_000;
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/**
 * When a conversation is folded into a summary — one rule for chat
 * (apps/web/lib/chat/compaction.ts) and agent runs (apps/worker-agents):
 * once the next request would fill this much of the room the window leaves
 * after the reply. Below it nothing is summarized; fitMessages is only the
 * last line for what a fold cannot shrink.
 */
export const COMPACT_WINDOW_FRACTION = 0.85;
/**
 * Characters per token for ESTIMATING a request's size where no call has
 * measured it — a middle reading, for deciding when to fold. The budget
 * fitMessages enforces uses the more conservative CHARS_PER_TOKEN.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 3.5;

/** Whether a request of `requestTokens` should be folded first, by COMPACT_WINDOW_FRACTION. */
export function overCompactionThreshold(
  requestTokens: number,
  model: { contextWindow: number; maxOutputTokens: number }
): boolean {
  const room = Math.max(model.contextWindow - model.maxOutputTokens, 0);
  return requestTokens > room * COMPACT_WINDOW_FRACTION;
}

/**
 * How many characters of messages one request may carry: the window less
 * the reply's room, a margin, and what the system prompt and tool
 * definitions already take.
 */
export function transcriptBudgetChars(input: {
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** System prompt plus serialized tool definitions. */
  fixedChars: number;
}): number {
  const usable = Math.max(0, input.contextWindowTokens - input.maxOutputTokens);
  const chars = Math.floor(usable * CHARS_PER_TOKEN * 0.9) - input.fixedChars;
  return Math.max(MIN_TRANSCRIPT_CHARS, chars);
}

/** A block's size as the provider will read it. */
export function blockChars(block: LlmContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length;
    case 'thinking':
      return block.thinking.length;
    case 'redacted_thinking':
      return block.data.length;
    case 'tool_use':
      return JSON.stringify(block.input ?? {}).length + block.name.length;
    case 'tool_result':
      return block.content.length;
    default:
      // Attachments (documents, images) are sized by the provider in their own
      // units; counted at a flat rate so they are not invisible.
      return 4_000;
  }
}

export function messagesChars(messages: readonly LlmMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + message.content.reduce((inner, block) => inner + blockChars(block), 0),
    0
  );
}

/** `text` in at most `keep` characters, the marker included: head and tail, the cut said between. */
function headTail(text: string, keep: number, what: string): string {
  if (text.length <= keep) return text;
  const marker = (cut: number) =>
    `\n… [${cut} characters cut from the middle of this ${what} to fit the model's context — ` +
    'call again with a narrower request for what is missing] …\n';
  const room = Math.max(0, keep - marker(text.length).length);
  const head = Math.ceil(room * 0.7);
  const tail = room - head;
  return `${text.slice(0, head)}${marker(text.length - head - tail)}${tail > 0 ? text.slice(-tail) : ''}`;
}

export interface FitResult {
  messages: LlmMessage[];
  /** Characters cut; 0 when the messages already fit. */
  cut: number;
}

/**
 * The messages, shrunk until they fit `budget` characters — or as close
 * as they can get without dropping anything (a recent block is never cut
 * below RECENT_BLOCK_MIN_CHARS). The input is not modified.
 */
export function fitMessages(
  input: readonly LlmMessage[],
  budget: number,
  recentMessages = RECENT_MESSAGES
): FitResult {
  const before = messagesChars(input);
  if (before <= budget) return { messages: [...input], cut: 0 };
  const messages: LlmMessage[] = input.map((message) => ({
    ...message,
    content: [...message.content],
  }));
  let total = before;
  const recentFrom = Math.max(0, messages.length - recentMessages);

  const replace = (at: [number, number], next: LlmContentBlock) => {
    const [m, b] = at;
    total += blockChars(next) - blockChars(messages[m].content[b]);
    messages[m].content[b] = next;
  };

  // 1. Old tool results, oldest first, to a short head.
  for (let m = 0; m < recentFrom && total > budget; m += 1) {
    messages[m].content.forEach((block, b) => {
      if (total <= budget || block.type !== 'tool_result') return;
      if (block.content.length <= OLD_RESULT_HEAD_CHARS) return;
      replace([m, b], {
        ...block,
        content: `${block.content.slice(0, OLD_RESULT_HEAD_CHARS)}\n… [earlier result elided to keep the conversation within the model's limits; call the tool again if you need it whole]`,
      });
    });
  }

  // 2. Old large tool inputs and assistant text.
  for (let m = 0; m < recentFrom && total > budget; m += 1) {
    messages[m].content.forEach((block, b) => {
      if (total <= budget) return;
      if (block.type === 'tool_use' && blockChars(block) > OLD_BLOCK_MAX_CHARS) {
        const size = JSON.stringify(block.input ?? {}).length;
        replace([m, b], {
          ...block,
          input: { _elided: `${size} characters of arguments, elided from this earlier call` },
        });
      } else if (block.type === 'text' && block.text.length > OLD_BLOCK_MAX_CHARS) {
        replace([m, b], {
          ...block,
          text: headTail(block.text, OLD_BLOCK_MAX_CHARS, 'earlier message'),
        });
      }
    });
  }

  // 3–4. The recent window: its largest blocks, results first, cut to an
  // even share of what is left, head and tail kept.
  const passes: ReadonlySet<string>[] = [new Set(['tool_result']), new Set(['text', 'tool_use'])];
  for (const kinds of passes) {
    if (total <= budget) break;
    const candidates: [number, number][] = [];
    for (let m = recentFrom; m < messages.length; m += 1) {
      messages[m].content.forEach((block, b) => {
        if (kinds.has(block.type)) candidates.push([m, b]);
      });
    }
    // Largest first; each pass cuts the biggest down toward an even share.
    candidates.sort(
      (a, b) => blockChars(messages[b[0]].content[b[1]]) - blockChars(messages[a[0]].content[a[1]])
    );
    for (let index = 0; index < candidates.length && total > budget; index += 1) {
      const at = candidates[index];
      const block = messages[at[0]].content[at[1]];
      const size = blockChars(block);
      const others = candidates
        .slice(index + 1)
        .reduce((sum, next) => sum + blockChars(messages[next[0]].content[next[1]]), 0);
      const room = budget - (total - size - others);
      const share = Math.max(
        RECENT_BLOCK_MIN_CHARS,
        Math.floor(room / (candidates.length - index))
      );
      if (size <= share) continue;
      if (block.type === 'tool_result') {
        replace(at, { ...block, content: headTail(block.content, share, 'result') });
      } else if (block.type === 'text') {
        replace(at, { ...block, text: headTail(block.text, share, 'message') });
      } else if (block.type === 'tool_use') {
        replace(at, {
          ...block,
          input: { _elided: `${size} characters of arguments, elided to fit the model's context` },
        });
      }
    }
  }
  return { messages, cut: before - total };
}
