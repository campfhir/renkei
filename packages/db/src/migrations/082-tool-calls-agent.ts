import { Kysely, sql } from 'kysely';

/**
 * Which agent made a tool call, on the call itself.
 *
 * An agent's tool calls have always landed in `tool_calls` — a run
 * executes tools through the MCP gateway under a token bound to the
 * owner's subject (RENKEI.md Decision #21) — but only the subject was
 * recorded, so "this agent's calls" could only be answered by reading
 * the per-attempt JSON on `agent_run_steps.detail`, which is content,
 * audience-gated, and pruned by run retention. The token already names
 * the acting agent (migration 040); stamping it here makes the ledger
 * answer per agent as well as per person, with nothing about the call's
 * content added. Null for a person's own calls from a chat client.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('tool_calls')
    .addColumn('agent_id', 'uuid', (col) => col.references('agents.id').onDelete('set null'))
    .execute();

  await sql`
    CREATE INDEX idx_tool_calls_agent ON tool_calls (tenant_id, agent_id, started_at)
      WHERE agent_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tool_calls').dropColumn('agent_id').execute();
}
