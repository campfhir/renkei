/**
 * What a card tells the model once the person has decided on it
 * (bridge.ts's `updateModelContext`): the card's own sentence, and — when
 * the decision ran a tool — what that tool answered.
 *
 * The card's receipt shows the person a headline and a link; the model
 * needs the rest. A confirm tool's answer carries the ids and addresses of
 * what was made (a meeting's id and join link, an issue's key, a message's
 * id), and the next step usually stands on them: the invite needs the join
 * link. Left to each card's own sentence they were lost wherever a card
 * did not think to repeat them, and the model asked the person to paste
 * them. So the bridge adds the answer to every card's update, as a second
 * block the thread never draws (a decision row is not shown at all).
 *
 * Nothing is added when no tool ran (Cancel), when the tool said nothing,
 * or when the card's sentence already carries the answer word for word.
 * Tested in model-context.model.test.ts.
 */

/** The last call a card made that answered without an error. */
export interface AnsweredCall {
  tool: string;
  /** The answer's text blocks, joined. */
  text: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

/** Room for the answer beside the card's sentence, under the host's own cap on the whole update. */
export const ANSWER_MAX_CHARS = 3_000;

/** The text of a tool result's text blocks, one per line. */
export function answerText(
  content: readonly { type: string; text?: string }[] | undefined
): string {
  return (content ?? [])
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('\n')
    .trim();
}

/** The blocks of one `ui/update-model-context`: the card's sentence, then the tool's answer. */
export function modelContextBlocks(text: string, answered: AnsweredCall | null): TextBlock[] {
  const blocks: TextBlock[] = [{ type: 'text', text }];
  const answer = answered?.text.trim() ?? '';
  if (!answered || !answer || text.includes(answer)) return blocks;
  const kept =
    answer.length > ANSWER_MAX_CHARS ? `${answer.slice(0, ANSWER_MAX_CHARS)}… (cut)` : answer;
  blocks.push({
    type: 'text',
    text:
      `What ${answered.tool} answered — the person saw only the card's receipt, not this; ` +
      `use the ids and links here rather than asking for them:\n${kept}`,
  });
  return blocks;
}
