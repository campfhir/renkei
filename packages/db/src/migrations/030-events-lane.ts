import { Kysely } from 'kysely';

/**
 * Partition the events queue into lanes, one consumer process per lane.
 *
 * The single claim stream (013) meant one slow event class could starve
 * every other: embedding/ingestion work — network calls to an
 * org-configured endpoint, hundreds of them for a mailbox rebuild — ran in
 * the same serial loop that answers WebEx messages. Decision #20 splits the
 * consumers: the interactive worker and the embedding worker each claim
 * only their own lane, so ingestion latency can never gate a reply.
 *
 * The default keeps every producer and every pre-existing row in the
 * interactive lane; only worker-originated `knowledge/*` events opt into
 * the embedding lane at INSERT time.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('events')
    .addColumn('lane', 'varchar(32)', (col) => col.notNull().defaultTo('interactive'))
    .execute();

  // The claim query's exact shape, per lane: ready work, oldest first.
  await db.schema
    .createIndex('idx_events_claim_lane')
    .on('events')
    .columns(['lane', 'status', 'run_after', 'created_at'])
    .execute();
  await db.schema.dropIndex('idx_events_claim').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('idx_events_claim')
    .on('events')
    .columns(['status', 'run_after', 'created_at'])
    .execute();
  await db.schema.dropIndex('idx_events_claim_lane').execute();
  await db.schema.alterTable('events').dropColumn('lane').execute();
}
