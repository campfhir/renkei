import { Kysely, sql } from 'kysely';

/**
 * `agents.allowed_actions` — the actions (act tool names) an agent's staged
 * batches may carry without waiting for its owner: "runs without asking",
 * per tool, per agent (@renkei/agents' act-approval.ts). Anything else
 * waits; the organization's locked high-risk tools always wait. It
 * replaces `auto_accept_actions` (one switch for every action, with the
 * owner's agents high-risk list holding some back), which stays as stored
 * but is no longer read.
 *
 * Backfilled so nothing changes on the day: an agent that accepted its own
 * actions gets every tool it has, less the organization's locked tools and
 * the owner's agents high-risk marks (user_preferences 'agentHighRisk').
 * A read tool on the list is harmless: only staged actions consult it.
 * An agent that did not accept its own actions gets none.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agents')
    .addColumn('allowed_actions', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();
  await sql`
    UPDATE agents a
       SET allowed_actions = COALESCE((
         SELECT jsonb_agg(t.name ORDER BY t.name)
           FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(a.tools) = 'array' THEN a.tools ELSE '[]'::jsonb END
                ) AS t(name)
          WHERE NOT COALESCE(
                  (SELECT s.value ? t.name
                     FROM settings s
                    WHERE s.key = 'locked_high_risk_tools'
                      AND jsonb_typeof(s.value) = 'array'),
                  false)
            AND NOT COALESCE(
                  (SELECT p.value -> 'marked' ? t.name
                     FROM user_preferences p
                    WHERE p.subject = a.owner_subject
                      AND p.key = 'agentHighRisk'),
                  false)
       ), '[]'::jsonb)
     WHERE a.auto_accept_actions
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE agents DROP COLUMN allowed_actions`.execute(db);
}
