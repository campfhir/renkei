import { Kysely, sql } from 'kysely';

/**
 * Health check-ins: an application that was deployed tells Renkei it is
 * alive. Optional, and the developer's to implement: a project issues a
 * token for one of its environments, the application carries it and POSTs
 * its status (`starting`, `healthy`, …) on a rhythm it chooses, and the
 * environment shows the last one — or that one is late.
 *
 * One row an environment of a project: the token as a SHA-256 hash (the
 * token itself is shown once, when issued, and never stored), and the last
 * check-in — what it said, when the application sent it and when it
 * arrived, and how long until the next is due. A row with no check-in yet
 * is a token waiting to be used. There is no history: lateness is read
 * from the last check-in and the clock.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ci_health_checkins (
      project_id UUID NOT NULL REFERENCES chat_projects(id) ON DELETE CASCADE,
      environment VARCHAR(40) NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      token_hint VARCHAR(8) NOT NULL,
      issued_by VARCHAR(255) NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(16),
      message TEXT,
      version VARCHAR(120),
      sent_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ,
      interval_seconds INTEGER,
      checkins INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, environment)
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX idx_ci_health_checkins_token ON ci_health_checkins (token_hash)`.execute(
    db
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS ci_health_checkins`.execute(db);
}
