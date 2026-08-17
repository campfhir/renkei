import { Kysely } from 'kysely';

/**
 * Name the agent behind an agent-runner token.
 *
 * A run token (application 'agent', minted per run by the agents worker)
 * carries the run OWNER's subject — deliberately, so every gate the MCP
 * endpoint applies to the owner applies to their agents. But that made an
 * agent run indistinguishable from its owner at the tool layer: the
 * `application` marker was checked for authentication and then discarded,
 * so a tool could never say "an agent wrote this" or scope agent-authored
 * data apart from user-authored data.
 *
 * `agent_id` names the acting agent; NULL for every other token class.
 * Nullable with ON DELETE SET NULL rather than an FK-less copy: token rows
 * are short-lived (revoked at run end, TTL as backstop), so a deleted
 * agent self-cleans instead of blocking deletion.
 *
 * The run id is deliberately NOT carried: the MCP handler cache is keyed
 * per caller identity, and a per-run key would rebuild the handler for
 * every run while adding nothing the tools need — agent-level provenance
 * is what knowledge/card stamping requires.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('oauth_access_tokens')
    .addColumn('agent_id', 'uuid', (col) => col.references('agents.id').onDelete('set null'))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('oauth_access_tokens').dropColumn('agent_id').execute();
}
