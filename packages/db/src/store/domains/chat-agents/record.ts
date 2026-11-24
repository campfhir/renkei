import type { Row } from '../../memory/tables';
import type { ChatAgentAskRecord, ChatProjectAgentRecord } from './types';

export function askFromRow(row: Row<'chat_agent_asks'>): ChatAgentAskRecord {
  return {
    runId: row.run_id,
    chatId: row.chat_id,
    toolUseId: row.tool_use_id,
    agentId: row.agent_id,
    askedBy: row.asked_by,
    createdAt: row.created_at,
  };
}

export function projectAgentFromRow(row: Row<'chat_project_agents'>): ChatProjectAgentRecord {
  return {
    projectId: row.project_id,
    agentId: row.agent_id,
    addedBy: row.added_by,
    createdAt: row.created_at,
  };
}
