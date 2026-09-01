import { Kysely, sql } from 'kysely';

/**
 * Naming and recurring schedules for batch jobs — the agents/agent_triggers
 * split, adapted to batch jobs' simpler single-purpose-per-batch shape (no
 * event/api/agent-chaining trigger kinds, just "run it once" vs. "run it on
 * a schedule").
 *
 * Every `batch_jobs` row today is a one-off run with nothing to attach a
 * recurrence to — this adds `batch_job_schedules` as the recipe a recurring
 * batch is defined once against, and each firing creates an ordinary
 * `batch_jobs` row tagged with `schedule_id`. The recurrence math and
 * config shape are the exact ones @renkei/agents already defines
 * (`ScheduleConfig`, `computeNextRunForSchedule`) — not duplicated here,
 * just stored the same way agent_triggers stores them, including the
 * `next_run_at` optimistic-lock advance-then-fire discipline (`idx_..._due`
 * below is that mechanism's index).
 *
 * `name` is required on batch_jobs now too: with schedules producing many
 * runs of "document-ocr-pipeline" over time, `kind` + a timestamp stopped
 * being enough to tell batches apart in the list.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('batch_job_schedules')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('kind', 'varchar(64)', (col) => col.notNull())
    // Kind-specific parameters — same shape a one-off batch_jobs.config
    // carries (for document-ocr-pipeline: {shareId, path, grouping}).
    .addColumn('config', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    // A ScheduleConfig (packages/agents/src/recurrence.ts) — recurrences,
    // timezone, startAt, calendarId, blackouts, blackoutPolicy. Same
    // serialized shape agent_triggers.config uses for kind='schedule'.
    .addColumn('schedule_config', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    // Advanced with an optimistic UPDATE ... WHERE next_run_at = observed,
    // so N sweep instances never double-fire — see apps/worker/src/batch-jobs/schedule-sweep.ts.
    .addColumn('next_run_at', 'timestamptz')
    .addColumn('last_fired_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('batch_job_schedules_tenant_name', ['tenant_id', 'name'])
    .execute();

  await db.schema
    .createIndex('idx_batch_job_schedules_owner')
    .on('batch_job_schedules')
    .columns(['tenant_id', 'subject'])
    .execute();

  await sql`
    CREATE INDEX idx_batch_job_schedules_due ON batch_job_schedules (next_run_at)
      WHERE enabled
  `.execute(db);

  await db.schema
    .alterTable('batch_jobs')
    .addColumn('name', 'varchar(200)', (col) => col.notNull().defaultTo('Untitled batch'))
    .execute();

  await db.schema
    .alterTable('batch_jobs')
    .addColumn('schedule_id', 'uuid', (col) =>
      col.references('batch_job_schedules.id').onDelete('set null')
    )
    .execute();

  await sql`
    CREATE INDEX idx_batch_jobs_schedule ON batch_jobs (schedule_id)
      WHERE schedule_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('batch_jobs').dropColumn('schedule_id').execute();
  await db.schema.alterTable('batch_jobs').dropColumn('name').execute();
  await db.schema.dropTable('batch_job_schedules').execute();
}
