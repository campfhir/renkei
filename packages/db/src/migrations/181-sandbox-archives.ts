import { Kysely, sql } from 'kysely';

/**
 * A sandbox's archive: what it held, kept when it is evicted.
 *
 * A sandbox nothing has called for a day is evicted
 * (docs/sandbox-orchestrator-design.md). Before its machine is removed,
 * what it holds — the scope's staged files and checkouts — is written,
 * compressed, to the blob store; the next call for the scope makes a new
 * machine and unpacks it there. So eviction frees the machine, not the
 * work.
 *
 * `sandbox_archives` is where a scope's archive is: at most one per
 * scope (`route_key`), replaced by the next eviction. `blob_key` is the
 * object in the blob store; `sandbox_id` is the sandbox it was taken
 * from. An archive nobody has come back for is dropped after a
 * retention period, found by `created_at`.
 *
 * `archiving` joins the sandbox states: the sandbox is being written to
 * the blob store on its way out. It is its own state, apart from
 * `deleting`, because an orchestrator that dies while archiving must
 * leave a sandbox that is put back as it was, never one whose machine is
 * removed with the archive half written.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE sandbox_archives (
      route_key  TEXT PRIMARY KEY,
      sandbox_id UUID NOT NULL,
      blob_key   TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX sandbox_archives_created_idx ON sandbox_archives (created_at)
  `.execute(db);
  await sql`ALTER TABLE sandboxes DROP CONSTRAINT sandboxes_state_check`.execute(db);
  await sql`
    ALTER TABLE sandboxes ADD CONSTRAINT sandboxes_state_check
      CHECK (state IN ('provisioning', 'running', 'suspending', 'suspended',
                       'resuming', 'archiving', 'deleting', 'deleted'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE sandboxes SET state = 'suspended' WHERE state = 'archiving'`.execute(db);
  await sql`ALTER TABLE sandboxes DROP CONSTRAINT sandboxes_state_check`.execute(db);
  await sql`
    ALTER TABLE sandboxes ADD CONSTRAINT sandboxes_state_check
      CHECK (state IN ('provisioning', 'running', 'suspending', 'suspended',
                       'resuming', 'deleting', 'deleted'))
  `.execute(db);
  await sql`DROP TABLE IF EXISTS sandbox_archives`.execute(db);
}
