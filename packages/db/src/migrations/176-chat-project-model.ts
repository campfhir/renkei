import { Kysely, sql } from 'kysely';

/**
 * A project's own model: what a new chat in the project (a chat project or
 * a code project, the same row) starts on. Null is "no choice of its own":
 * the chat takes its owner's preferred chat model, else the organization
 * default. Removing the model leaves the project with no choice, as it
 * does a chat or an agent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE chat_projects
      ADD COLUMN llm_model_id uuid REFERENCES llm_model_configs(id) ON DELETE SET NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chat_projects DROP COLUMN llm_model_id`.execute(db);
}
