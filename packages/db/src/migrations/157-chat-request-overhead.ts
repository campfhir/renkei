import { Kysely } from 'kysely';

/**
 * The tokens a chat's requests carry beyond its messages — the system prompt
 * and the tool definitions — as the last turn built them. The context meter
 * and auto-compaction add it to their estimate of the next request, so a
 * chat with many connectors enabled is not under-counted. Null until a turn
 * has run; readers fall back to a flat allowance.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chats').addColumn('request_overhead_tokens', 'integer').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chats').dropColumn('request_overhead_tokens').execute();
}
