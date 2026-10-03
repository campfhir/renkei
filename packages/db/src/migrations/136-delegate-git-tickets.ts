import { Kysely, sql } from 'kysely';

/**
 * Tickets for the delegate's git proxy (docs/delegate-key-design.md).
 *
 * A code workspace clones, pulls and pushes over HTTPS through the
 * delegate rather than with a token of its own: the web app asks the
 * delegate for a ticket bound to one person, one provider, one host and
 * one direction (read or write), and the sandbox worker's git is pointed
 * at `<delegate>/git/<ticket>/<host>/…` for that one operation. The
 * delegate looks the ticket up here, attaches the person's token on the
 * way out, and the sandbox never holds anything that outlives the call.
 *
 * Rows hold a hash of the ticket's secret, never the secret: a read of
 * this table cannot mint a usable ticket. Expired rows are swept by the
 * delegate as it goes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE delegate_git_tickets (
      id          UUID PRIMARY KEY,
      tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      subject     TEXT NOT NULL,
      provider    TEXT NOT NULL,
      host        TEXT NOT NULL,
      write       BOOLEAN NOT NULL DEFAULT FALSE,
      secret_hash TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
  await sql`
    CREATE INDEX delegate_git_tickets_expires_idx ON delegate_git_tickets (expires_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS delegate_git_tickets`.execute(db);
}
