/**
 * The person's own words for the turn that is running: what they last
 * typed, exactly. A paste past a size limit is stored across several
 * `prompt` rows (start-turn.ts), so the run of prompt rows ending at the
 * latest one is joined back into the message it was; anything else that
 * sits between — the assistant's replies, tool results, nudges, notes —
 * is not theirs and is skipped over to find it. Pure: it reads rows, not a database.
 */

import type { LlmContentBlock } from '@renkei/agent-llm';

interface RowLike {
  role: string;
  kind: string;
  blocks: LlmContentBlock[];
}

function textOf(blocks: LlmContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

export function latestUserPrompt(rows: readonly RowLike[]): string {
  let end = rows.length - 1;
  while (end >= 0 && !(rows[end]!.role === 'user' && rows[end]!.kind === 'prompt')) end -= 1;
  if (end < 0) return '';
  let start = end;
  while (start > 0 && rows[start - 1]!.role === 'user' && rows[start - 1]!.kind === 'prompt') {
    start -= 1;
  }
  return rows
    .slice(start, end + 1)
    .map((row) => textOf(row.blocks))
    .join('')
    .trim();
}
