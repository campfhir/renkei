/**
 * Give every existing agent note the membership marker.
 *
 * `metadata.agentId` used to mean two things at once: provenance ("an agent
 * wrote this org note") and membership ("inject this into that agent's every
 * run"). `knowledge_create_note` stamps the first whenever an agent calls it,
 * so a step using that tool silently grew its own agent's prompt forever.
 * `metadata.scope` now carries membership alone, set only by the deliberate
 * paths — the knowledge panel and `agent_knowledge_write`.
 *
 * Existing rows are indistinguishable: both writers stored the same
 * `{kind, title, authoredBy, agentId}`. `authoredBy` correlates ('agent'
 * comes from knowledge_create_note, 'user' from the panel) but only by
 * accident of who happened to call which tool, and betting an agent's
 * knowledge on that would silently drop notes people deliberately wrote.
 *
 * So this preserves TODAY'S behaviour exactly: everything currently injected
 * keeps being injected. Only NEW implicit writes stop becoming members, and
 * the knowledge panel's bulk selection is how an owner prunes what is
 * already there — a visible cleanup they choose, rather than an invisible
 * one this migration performs.
 */

import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE knowledge_chunks
       SET metadata = jsonb_set(metadata, '{scope}', '"agent"'::jsonb)
     WHERE provider = 'note'
       AND metadata ? 'agentId'
       AND NOT (metadata ? 'scope')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE knowledge_chunks
       SET metadata = metadata - 'scope'
     WHERE provider = 'note'
       AND metadata ->> 'scope' = 'agent'
  `.execute(db);
}
