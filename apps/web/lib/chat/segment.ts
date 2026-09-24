/**
 * A reply, read across its rows: prose, and the work between the prose —
 * folded into the cards the thread shows. Pure; the icons and the cards
 * themselves live in message-list.tsx.
 */

import type { ChatBlock, ChatMessageView } from './views';
import { milestoneKindOf } from '@/lib/code/milestones';
import { TASK_COMPLETE_TOOL } from './auto-mode';

export type ToolResult = Extract<ChatBlock, { type: 'tool_result' }>;

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string }
  /**
   * `modelMs`: the model calls behind these steps, summed from the timing
   * of each assistant row that put a step here (once per row, on its
   * first step); 0 when no row carried timing.
   */
  | { kind: 'work'; steps: WorkStep[]; modelMs: number }
  /** A commit, a push, a word to Bitbucket — a card of its own, never folded. */
  | { kind: 'milestone'; step: Extract<WorkStep, { kind: 'call' }> }
  /** A sub-agent at work, or its report: a card with its progress and a way into its transcript. */
  | { kind: 'subagent'; step: Extract<WorkStep, { kind: 'call' }> }
  /**
   * A call whose result is bound to an MCP Apps widget (its tool_result's
   * `uiResourceUri` — turn-runner.ts stamps it on from the tool's
   * `_meta.ui.resourceUri`): rendered as the card, never folded. Known
   * only once the result arrives — a call still pending sits in `work`
   * like any other, and takes this card's place the moment it resolves.
   */
  | { kind: 'widget'; step: Extract<WorkStep, { kind: 'call' }> }
  /** Auto mode's runner-written "carry on", between two of the model's replies. */
  | { kind: 'nudge'; text: string }
  /** What the person did to the checkout from the code pane (lib/code/notes.ts). */
  | { kind: 'person'; text: string };

export type WorkStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'redacted' }
  | { kind: 'call'; block: Extract<ChatBlock, { type: 'tool_use' }>; result: ToolResult | null };

export function segment(messages: ChatMessageView[], results: Map<string, ToolResult>): Segment[] {
  const out: Segment[] = [];
  // Each assistant row's model call is counted once, on the fold its
  // first step lands in — a row that also wrote prose before its next
  // step still made one call.
  let countedRow: string | null = null;
  const work = (message: ChatMessageView): Extract<Segment, { kind: 'work' }> => {
    const last = out[out.length - 1];
    const fold: Extract<Segment, { kind: 'work' }> =
      last && last.kind === 'work' ? last : { kind: 'work', steps: [], modelMs: 0 };
    if (fold !== last) out.push(fold);
    if (countedRow !== message.id && message.timing) {
      fold.modelMs += message.timing.durationMs;
      countedRow = message.id;
    }
    return fold;
  };
  // A milestone or sub-agent card is never folded, so two of them for one
  // call — a stale, still-empty block beside the one the stream later
  // finished parsing, both carrying the same tool_use id — would stand out
  // as an actual duplicate on screen, not a buried repeat. The call's id is
  // stable start to finish, so a second sighting updates the FIRST card in
  // place instead of opening a second one for what is, underneath, the one
  // call the person is already watching.
  const cards = new Map<string, Extract<Segment, { kind: 'milestone' | 'subagent' | 'widget' }>>();
  for (const message of messages) {
    if (message.role !== 'assistant') {
      if (message.kind === 'nudge' || message.kind === 'note') {
        const text = message.blocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n');
        out.push({ kind: message.kind === 'nudge' ? 'nudge' : 'person', text });
      }
      continue;
    }
    for (const block of message.blocks) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) out.push({ kind: 'text', text: block.text });
          break;
        case 'thinking':
          work(message).steps.push({ kind: 'thinking', text: block.thinking });
          break;
        case 'redacted_thinking':
          work(message).steps.push({ kind: 'redacted' });
          break;
        case 'tool_use': {
          const step = { kind: 'call' as const, block, result: results.get(block.id) ?? null };
          const already = cards.get(block.id);
          if (already) {
            already.step = step;
            break;
          }
          if (block.name === 'code_delegate') {
            const card: Extract<Segment, { kind: 'subagent' }> = { kind: 'subagent', step };
            out.push(card);
            cards.set(block.id, card);
          } else if (milestoneKindOf(block.name) !== null || block.name === TASK_COMPLETE_TOOL) {
            const card: Extract<Segment, { kind: 'milestone' }> = { kind: 'milestone', step };
            out.push(card);
            cards.set(block.id, card);
          } else if (step.result?.uiResourceUri) {
            const card: Extract<Segment, { kind: 'widget' }> = { kind: 'widget', step };
            out.push(card);
            cards.set(block.id, card);
          } else {
            work(message).steps.push(step);
          }
          break;
        }
        case 'tool_result':
          break;
        case 'document':
        case 'image':
          out.push({
            kind: 'note',
            text: `${block.type === 'document' ? (block.title ?? 'Document') : 'Image'} attached`,
          });
          break;
      }
    }
  }
  return out;
}
