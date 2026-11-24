import { Kysely, sql } from 'kysely';

/**
 * What was last said about an environment's health: the state people and
 * agents were last told (`healthy`, `error`, `late`, `failed`, …). A
 * check-in that changes the state, and a sweep that finds a check-in
 * overdue, each compare against it and move it in one statement, so a
 * change is announced once however many processes see it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ci_health_checkins ADD COLUMN announced_state VARCHAR(16)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ci_health_checkins DROP COLUMN announced_state`.execute(db);
}
