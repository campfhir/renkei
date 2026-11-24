import { Kysely, sql } from 'kysely';

/**
 * Agents in chat: a chat can hand a task to one of the person's agents,
 * the way they would message a colleague who knows the area
 * (apps/web/lib/chat/agent-asks.ts), and a chat project can name the
 * agents that work on it.
 *
 * `chat_agent_asks` — one row per task a chat handed an agent: the agent
 * run it started (an ordinary agent run, trigger kind 'chat') and the
 * `chat_ask_agent` call in the thread that started it, so the thread can
 * draw the agent's reply under that call, the chat's next turns can read
 * what the agent said, and the run's end can tell the person who asked.
 * Deleted with its chat, its run or its agent.
 *
 * `chat_project_agents` — a project's team: the agents its chats suggest
 * first and its page lists. Deleted with the project or the agent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_agent_asks')
    .addColumn('run_id', 'uuid', (col) =>
      col.primaryKey().references('agent_runs.id').onDelete('cascade')
    )
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('tool_use_id', 'varchar(128)', (col) => col.notNull())
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    .addColumn('asked_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('chat_agent_asks_call', ['chat_id', 'tool_use_id'])
    .execute();
  await db.schema
    .createIndex('idx_chat_agent_asks_chat')
    .on('chat_agent_asks')
    .columns(['chat_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('chat_project_agents')
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('chat_projects.id').onDelete('cascade')
    )
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    .addColumn('added_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('chat_project_agents_pkey', ['project_id', 'agent_id'])
    .execute();
  await db.schema
    .createIndex('idx_chat_project_agents_agent')
    .on('chat_project_agents')
    .columns(['agent_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('chat_project_agents').execute();
  await db.schema.dropTable('chat_agent_asks').execute();
}
