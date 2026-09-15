/**
 * chat_compact — the model's own handle on compaction.ts, for a
 * conversation it can tell has grown long (a code session with many tool
 * rounds, a big investigation) before start-turn.ts's automatic check
 * would trigger on its own. Offered in every chat: compaction touches only
 * this chat's own stored messages, never an organization system, so it is
 * not gated by project membership or read-only mode the way the memory
 * tools are.
 *
 * Its effect starts on the NEXT turn: the turn already under way built its
 * history before this call runs, so the model should not expect the
 * current reply's context to shrink mid-turn.
 */

import { compactChat } from './compaction';
import { errorResult, textResult, type LocalTool } from './local-tools';

export function compactionTools(): LocalTool[] {
  return [
    {
      def: {
        name: 'chat_compact',
        description:
          'Summarize the older part of this conversation into a compact summary so future turns stop resending it in full — use it once this chat has accumulated a lot of tool output, code or back-and-forth and continuing would otherwise crowd out useful context. The most recent messages always stay verbatim. Takes effect starting next turn, not this one.',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute(_input, context) {
        if (!context.llm) return errorResult('No model is available to summarize with.');
        let result;
        try {
          result = await compactChat(context.db, {
            tenantId: context.tenantId,
            chatId: context.chatId,
            llm: context.llm,
            createdBy: 'tool',
            onProgress: context.emitProgress,
          });
        } catch (error) {
          return errorResult(
            `Compaction failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        return result
          ? textResult(
              `Folded ${result.foldedCount} earlier message(s) into a summary. They will be replaced by the summary starting next turn.`
            )
          : textResult(
              'Nothing old enough to compact yet — too few messages sit outside the recent window.'
            );
      },
    },
  ];
}
