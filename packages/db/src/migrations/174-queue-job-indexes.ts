import { Kysely, sql } from 'kysely';

/**
 * Indexes the queue tables were missing, found when agent_jobs had grown
 * for months with nothing pruning its finished rows:
 *
 *  - agent_jobs by run (`payload->>'runId'`): a cancel, a halt, the
 *    stuck-run janitor and the queue panel all look a run's jobs up this
 *    way, and each was a full scan. The dead-letter twin the same, for the
 *    halt that drops a run's dead letters.
 *  - agent_jobs by source (an agent's lane) among live rows: the runs
 *    page's Queue panel.
 *  - the lease: `processing` rows by `locked_at`, which every claim scans
 *    for expired leases and the fair pick reads.
 *  - every queue table's settled rows (`processed`, `skipped`) by
 *    `created_at`: what the settled-row retention sweep deletes by
 *    (@renkei/queue, `createSettledRetentionSweep`), so pruning a large
 *    backlog never scans the live rows.
 */

const QUEUE_TABLES = ['events', 'embedding_jobs', 'agent_jobs', 'batch_job_messages'];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_jobs_run ON agent_jobs ((payload->>'runId'))`.execute(
    db
  );
  await sql`
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_dead_letters_run
      ON agent_jobs_dead_letters ((payload->>'runId'))
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_source_live
      ON agent_jobs (source, created_at) WHERE status IN ('pending', 'processing')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_lease
      ON agent_jobs (locked_at) WHERE status = 'processing'
  `.execute(db);
  for (const table of QUEUE_TABLES) {
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${table}_settled`)}
        ON ${sql.raw(table)} (created_at) WHERE status IN ('processed', 'skipped')
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of QUEUE_TABLES) {
    await sql`DROP INDEX IF EXISTS ${sql.raw(`idx_${table}_settled`)}`.execute(db);
  }
  await sql`DROP INDEX IF EXISTS idx_agent_jobs_lease`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_jobs_source_live`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_jobs_dead_letters_run`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_jobs_run`.execute(db);
}
