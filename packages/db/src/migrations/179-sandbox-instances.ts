import { Kysely, sql } from 'kysely';

/**
 * Sandbox instances and who each one serves.
 *
 * The sandbox worker runs as several instances, and much of what it
 * holds for a caller is one instance's alone: a notebook's kernel, a
 * language server, a preview's process, a browser session — and, once
 * instances stop sharing a disk, the checkouts themselves. So a caller
 * is served by ONE instance, the same one every time, rather than by
 * whichever a shared address happens to pick.
 *
 * `sandbox_instances` is the instances that are up: each writes its row
 * at boot and touches `last_seen_at` as it runs (the delegate's
 * instances table, for the same reason). `id` is stable across a
 * restart where the deployment gives the instance a stable name, so a
 * restarted instance is still the one its callers are assigned to, with
 * its disk; `address` is where the app reaches it directly.
 *
 * `sandbox_assignments` is which instance a caller (a person's subject,
 * or a code project's) is served by. The app assigns a caller on its
 * first call and moves it only when its instance has stopped answering;
 * what that instance held for it is then gone, and is made again where
 * it lands (a repository is cloned again). No foreign key: an instance's
 * row goes when it does, and the assignment is what says where the
 * caller's things were.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE sandbox_instances (
      id           TEXT PRIMARY KEY,
      address      TEXT NOT NULL,
      started_at   TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE TABLE sandbox_assignments (
      subject     TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX sandbox_assignments_instance_idx ON sandbox_assignments (instance_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS sandbox_assignments`.execute(db);
  await sql`DROP TABLE IF EXISTS sandbox_instances`.execute(db);
}
