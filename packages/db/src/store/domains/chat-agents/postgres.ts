import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { askFromRow, projectAgentFromRow } from './record';
import type { ChatAgentStore } from './types';

export function postgresChatAgents(db: () => Kysely<DB>): ChatAgentStore {
  return {
    async recordAsk(ask) {
      await db()
        .insertInto('chat_agent_asks')
        .values({
          run_id: ask.runId,
          chat_id: ask.chatId,
          tool_use_id: ask.toolUseId,
          agent_id: ask.agentId,
          asked_by: ask.askedBy,
        })
        .execute();
    },
    async listAsks(chatId) {
      const rows = await db()
        .selectFrom('chat_agent_asks')
        .selectAll()
        .where('chat_id', '=', chatId)
        .orderBy('created_at')
        .orderBy('run_id')
        .execute();
      return rows.map(askFromRow);
    },
    async findAskByRun(runId) {
      const row = await db()
        .selectFrom('chat_agent_asks')
        .selectAll()
        .where('run_id', '=', runId)
        .executeTakeFirst();
      return row ? askFromRow(row) : null;
    },
    async findAskByCall(chatId, toolUseId) {
      const row = await db()
        .selectFrom('chat_agent_asks')
        .selectAll()
        .where('chat_id', '=', chatId)
        .where('tool_use_id', '=', toolUseId)
        .executeTakeFirst();
      return row ? askFromRow(row) : null;
    },
    async listProjectAgents(projectId) {
      const rows = await db()
        .selectFrom('chat_project_agents')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at')
        .orderBy('agent_id')
        .execute();
      return rows.map(projectAgentFromRow);
    },
    async addProjectAgent(projectId, agentId, addedBy) {
      const inserted = await db()
        .insertInto('chat_project_agents')
        .values({ project_id: projectId, agent_id: agentId, added_by: addedBy })
        .onConflict((oc) => oc.columns(['project_id', 'agent_id']).doNothing())
        .returning('agent_id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async removeProjectAgent(projectId, agentId) {
      const result = await db()
        .deleteFrom('chat_project_agents')
        .where('project_id', '=', projectId)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
