import { Kysely, sql } from 'kysely';

/**
 * Token limits per person. The limits themselves are organization settings
 * (`token_limit_weekly`, `token_limit_monthly`, the weekly reset's day and
 * time, per-model limits); what a person has used is the token ledger
 * (`llm_calls`), summed since the period began. These two tables hold what
 * an operator decides about one person:
 *
 *   - `token_limit_exemptions`: the people no limit applies to;
 *   - `token_limit_boosts`: extra tokens an operator granted for the week or
 *     the month in progress. A boost carries the instant its period ends
 *     (`expires_at`), fixed when it is granted, so moving the organization's
 *     reset day later neither revives nor cuts short a boost already given.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('token_limit_exemptions')
    .addColumn('subject', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('set_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createTable('token_limit_boosts')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('period', 'varchar(8)', (col) => col.notNull())
    .addColumn('tokens', 'bigint', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('granted_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('note', 'varchar(500)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await sql`
    ALTER TABLE token_limit_boosts
      ADD CONSTRAINT token_limit_boosts_period CHECK (period IN ('week', 'month')),
      ADD CONSTRAINT token_limit_boosts_tokens CHECK (tokens > 0)
  `.execute(db);
  await db.schema
    .createIndex('idx_token_limit_boosts_subject')
    .on('token_limit_boosts')
    .columns(['subject', 'expires_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('token_limit_boosts').execute();
  await db.schema.dropTable('token_limit_exemptions').execute();
}
