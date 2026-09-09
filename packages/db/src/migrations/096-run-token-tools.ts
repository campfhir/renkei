import { Kysely, sql } from 'kysely';

/**
 * A run token names the tools it may see and call.
 *
 * An agent run's token used to reach the owner's whole tool surface: the
 * engine listed a few hundred schemas at the start of every run to look up
 * the one to three tools its steps actually name, and the token could
 * have called any of the rest. `tool_names` is the allow-list the agents
 * worker mints the token with — every tool a step or a retry guidance
 * chip names, plus the notifier's own — and the MCP gateway registers
 * only those for the token, so `tools/list` returns a handful of schemas
 * and a call to anything else is refused before any gate runs.
 *
 * NULL means unrestricted: MCP-client tokens issued through the OAuth
 * flow, and the run tokens a chat turn or a draft mints for a person
 * rather than an agent, keep the surface they always had.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oauth_access_tokens ADD COLUMN tool_names text[]`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oauth_access_tokens DROP COLUMN tool_names`.execute(db);
}
