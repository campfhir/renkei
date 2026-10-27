import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { memoryChatTurnEngine } from './engine-memory';
import { messageFromRow, summaryFromRow, turnFromRow } from './record';
import type { ChatThreadStore } from './types';

export function memoryChatThreads(tables: MemoryTables): ChatThreadStore {
  const chat = (value: string) => tables.param('chats', 'id', value);

  return {
    ...memoryChatTurnEngine(tables),
    async listMessages(chatId) {
      const id = chat(chatId);
      return orderBy(
        tables.select('chat_messages', (r) => r.chat_id === id),
        [(r) => r.seq]
      ).map(messageFromRow);
    },
    async listTurnMessages(turnId) {
      const id = tables.param('chat_messages', 'turn_id', turnId);
      return orderBy(
        tables.select('chat_messages', (r) => r.turn_id === id),
        [(r) => r.seq],
        [(r) => r.id]
      ).map(messageFromRow);
    },
    async getActiveTurn(chatId) {
      const id = chat(chatId);
      const [row] = orderBy(
        tables.select('chat_turns', (r) => r.chat_id === id && r.status === 'running'),
        [(r) => r.started_at, 'desc'],
        [(r) => r.id]
      );
      return row ? turnFromRow(row) : null;
    },
    async getTurn(chatId, turnId) {
      const id = chat(chatId);
      const turn = tables.param('chat_turns', 'id', turnId);
      const row = tables.first('chat_turns', (r) => r.chat_id === id && r.id === turn);
      return row ? turnFromRow(row) : null;
    },
    async latestSummary(chatId) {
      const id = chat(chatId);
      const [row] = orderBy(
        tables.select('chat_summaries', (r) => r.chat_id === id),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return row ? summaryFromRow(row) : null;
    },
    async listWidgetDecisions(chatId) {
      const id = chat(chatId);
      return orderBy(
        tables.select('chat_widget_decisions', (r) => r.chat_id === id),
        [(r) => r.state_key]
      ).map((r) => ({
        stateKey: r.state_key,
        state: r.state,
        decision: r.decision,
        decidedBy: r.decided_by,
      }));
    },
    async getWidgetDecision(stateKey) {
      return tables.first('chat_widget_decisions', (r) => r.state_key === stateKey)?.state ?? null;
    },
    async getDraft(chatId) {
      const id = chat(chatId);
      return tables.first('chat_drafts', (r) => r.chat_id === id)?.content ?? null;
    },
    async saveDraft(chatId, sealed) {
      tables.upsert('chat_drafts', { chat_id: chatId, content: sealed }, ['chat_id'], {
        content: sealed,
        updated_at: new Date(),
      });
    },
    async deleteDraft(chatId) {
      const id = chat(chatId);
      tables.delete('chat_drafts', (r) => r.chat_id === id);
    },
    async getQueue(chatId) {
      const id = chat(chatId);
      const row = tables.first('chat_queued_sends', (r) => r.chat_id === id);
      return row ? row.queue : null;
    },
    async saveQueue(chatId, queue) {
      const json = JSON.stringify(queue);
      tables.upsert('chat_queued_sends', { chat_id: chatId, queue: json }, ['chat_id'], {
        queue: json,
        updated_at: new Date(),
      });
    },
    async deleteQueue(chatId) {
      const id = chat(chatId);
      tables.delete('chat_queued_sends', (r) => r.chat_id === id);
    },
    async interruptStaleTurns(staleBefore, error) {
      const now = new Date();
      const before = orderBy(
        tables.select(
          'chat_turns',
          (r) => r.status === 'running' && r.updated_at.getTime() < staleBefore.getTime()
        ),
        [(r) => r.id]
      );
      if (before.length === 0) return [];
      const ids = new Set(before.map((row) => row.id));
      tables.update('chat_turns', (r) => ids.has(r.id), {
        status: 'interrupted',
        error,
        finished_at: now,
        updated_at: now,
      });
      tables.update(
        'chat_messages',
        (r) => r.turn_id !== null && ids.has(r.turn_id) && r.status === 'streaming',
        { status: 'interrupted', updated_at: now }
      );
      return before.map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        stage: row.stage,
        staleSince: row.updated_at,
      }));
    },
  };
}
