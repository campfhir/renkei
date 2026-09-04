/**
 * The runner's TurnStore over the real tables — the only place the loop's
 * "append a row", "flush the row", "am I canceled", "the turn is over"
 * touch Kysely. Token spend goes to the shared ledger under purpose
 * 'chat', attributed to the person whose turn it was.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { recordLlmCall } from '@renkei/agents/runs';
import { insertMessage, updateMessageContent } from './messages';
import { finishTurn, heartbeatTurn } from './turns';
import { touchChat } from './store';
import type { TurnStore } from './turn-runner';

export function createTurnStore(
  db: Kysely<DB>,
  scope: { tenantId: string; chatId: string; turnId: string; subject: string }
): TurnStore {
  return {
    async appendMessage(input) {
      const inserted = await insertMessage(db, {
        tenantId: scope.tenantId,
        chatId: scope.chatId,
        turnId: scope.turnId,
        role: input.role,
        kind: input.kind,
        status: input.status,
        blocks: input.blocks,
      });
      if (!inserted) throw new Error('The content encryption key is not configured.');
      return inserted;
    },
    async flushAssistant(id, blocks, patch) {
      await updateMessageContent(db, id, blocks, patch);
    },
    heartbeat(iterations) {
      return heartbeatTurn(db, scope.turnId, iterations);
    },
    async finishTurn(outcome) {
      await finishTurn(db, scope.turnId, outcome);
      await touchChat(db, scope.chatId, {});
    },
    async recordUsage(usage) {
      await recordLlmCall(db, {
        tenantId: scope.tenantId,
        subject: scope.subject,
        agentId: null,
        purpose: 'chat',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    },
  };
}
