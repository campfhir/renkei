import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { askFromRow, projectAgentFromRow } from './record';
import type { ChatAgentStore } from './types';

export function memoryChatAgents(tables: MemoryTables): ChatAgentStore {
  return {
    async recordAsk(ask) {
      tables.insert('chat_agent_asks', {
        run_id: ask.runId,
        chat_id: ask.chatId,
        tool_use_id: ask.toolUseId,
        agent_id: ask.agentId,
        asked_by: ask.askedBy,
        created_at: new Date(),
      });
    },
    async listAsks(chatId) {
      return orderBy(
        tables.select('chat_agent_asks', (r) => r.chat_id === chatId),
        [(r) => r.created_at],
        [(r) => r.run_id]
      ).map(askFromRow);
    },
    async findAskByRun(runId) {
      const row = tables.first('chat_agent_asks', (r) => r.run_id === runId);
      return row ? askFromRow(row) : null;
    },
    async findAskByCall(chatId, toolUseId) {
      const row = tables.first(
        'chat_agent_asks',
        (r) => r.chat_id === chatId && r.tool_use_id === toolUseId
      );
      return row ? askFromRow(row) : null;
    },
    async listProjectAgents(projectId) {
      return orderBy(
        tables.select('chat_project_agents', (r) => r.project_id === projectId),
        [(r) => r.created_at],
        [(r) => r.agent_id]
      ).map(projectAgentFromRow);
    },
    async addProjectAgent(projectId, agentId, addedBy) {
      const stored = tables.upsert(
        'chat_project_agents',
        { project_id: projectId, agent_id: agentId, added_by: addedBy, created_at: new Date() },
        ['project_id', 'agent_id']
      );
      return stored !== undefined;
    },
    async removeProjectAgent(projectId, agentId) {
      return (
        tables.delete(
          'chat_project_agents',
          (r) => r.project_id === projectId && r.agent_id === agentId
        ).length > 0
      );
    },
  };
}
