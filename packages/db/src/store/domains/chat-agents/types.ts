/**
 * Agents in chat (migration 183): the tasks a chat handed one of the
 * person's agents (`chat_agent_asks` — one agent run each, tied to the
 * `chat_ask_agent` call that started it), and the agents a chat project
 * names as its team (`chat_project_agents`). Who may ask which agent is
 * apps/web/lib/chat/agent-asks.ts's decision, not the store's.
 */

export interface ChatAgentAskRecord {
  runId: string;
  chatId: string;
  /** The chat_ask_agent call in the thread that started the run. */
  toolUseId: string;
  agentId: string;
  askedBy: string;
  createdAt: Date;
}

export interface NewChatAgentAsk {
  runId: string;
  chatId: string;
  toolUseId: string;
  agentId: string;
  askedBy: string;
}

export interface ChatProjectAgentRecord {
  projectId: string;
  agentId: string;
  addedBy: string;
  createdAt: Date;
}

export interface ChatAgentStore {
  /** Record a task a chat handed an agent (its run already exists). */
  recordAsk(ask: NewChatAgentAsk): Promise<void>;
  /** A chat's asks, oldest first (ties by run id). */
  listAsks(chatId: string): Promise<ChatAgentAskRecord[]>;
  /** The ask that started this run, or null for a run no chat started. */
  findAskByRun(runId: string): Promise<ChatAgentAskRecord | null>;
  /** The ask one call in a chat's thread made, or null. */
  findAskByCall(chatId: string, toolUseId: string): Promise<ChatAgentAskRecord | null>;

  /** A project's team, in the order they were added (ties by agent id). */
  listProjectAgents(projectId: string): Promise<ChatProjectAgentRecord[]>;
  /** Put an agent on a project's team; false when it is already there. */
  addProjectAgent(projectId: string, agentId: string, addedBy: string): Promise<boolean>;
  /** Take an agent off a project's team; false when it was not on it. */
  removeProjectAgent(projectId: string, agentId: string): Promise<boolean>;
}
