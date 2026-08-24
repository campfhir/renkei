import { Kysely } from 'kysely';

/**
 * Guardrails: an agent's standing instructions. Two columns, live-read at
 * run time (never snapshotted onto runs — tightening a safety rule must
 * bite in-flight runs immediately, the same reasoning as the org's live
 * attempt caps):
 *
 *  - `guardrails` — one free-form owner-authored document (role, sources
 *    of truth and precedence, content rules, hard rules) injected IN FULL
 *    into every model call the engine makes for this agent. Text on
 *    purpose, and deliberately not a knowledge note: notes require the
 *    org's embedder, and a safety document must not.
 *  - `blocked_tools` — a JSON array of tool names the engine refuses
 *    mechanically for model-driven calls, however a step or a corrective
 *    guidance chip asks. Enforcement lives in the engine and the
 *    validator; this is just the record.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agents').addColumn('guardrails', 'text').execute();
  await db.schema.alterTable('agents').addColumn('blocked_tools', 'jsonb').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agents').dropColumn('blocked_tools').execute();
  await db.schema.alterTable('agents').dropColumn('guardrails').execute();
}
