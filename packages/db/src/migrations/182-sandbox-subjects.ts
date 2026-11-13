import { Kysely, sql } from 'kysely';

/**
 * Whom a sandbox serves.
 *
 * A sandbox has no database: its worker's data store calls go to the
 * orchestrator (docs/sandbox-orchestrator-design.md). `subjects` is what
 * lets the orchestrator scope those calls to the calling sandbox: the
 * people — and the code project — whose work that sandbox has been asked
 * to do. The web app names the subject each time it asks where a scope's
 * sandbox is (it has already checked that person may work there), the
 * orchestrator adds it here, and a store call from the sandbox for
 * anyone not on the list is refused. A person's own sandbox serves that
 * person; a project's serves each member who has worked in it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sandboxes ADD COLUMN subjects TEXT[] NOT NULL DEFAULT '{}'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sandboxes DROP COLUMN IF EXISTS subjects`.execute(db);
}
