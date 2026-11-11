/**
 * The token limit for a person-started model call that is not a chat turn
 * or an agent run (those check where they start: lib/chat/start-turn.ts,
 * packages/agents/src/runs.ts): refining a prompt or a project's
 * instructions, drafting or analysing an agent. Each is small, but they add
 * up, and a person at their limit starts none of them.
 *
 * The refusal to show them, or null when they may go ahead.
 */
import { checkTokenLimit, tokenLimitMessage } from '@renkei/settings';

export async function tokenLimitRefusal(
  subject: string,
  llmModelId: string | null
): Promise<string | null> {
  const block = await checkTokenLimit(subject, llmModelId);
  return block ? tokenLimitMessage(block) : null;
}
