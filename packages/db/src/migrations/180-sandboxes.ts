import { Kysely, sql } from 'kysely';

/**
 * Sandboxes: one isolated machine per scope, made when it is first
 * needed and tracked here by the orchestrator
 * (docs/sandbox-orchestrator-design.md).
 *
 * Until now a caller was ASSIGNED to one of a few shared sandbox workers
 * (migration 179). A sandbox is instead the caller's own: a person's for
 * their chats, an agent's, a project's — a container the Docker engine
 * runs locally, a microVM in an Azure Container Apps sandbox group in
 * production. The orchestrator provisions it, suspends it when nothing
 * has called it for a while, resumes it on the next call, and removes it
 * once it has been idle for a day.
 *
 * `route_key` is the scope as callers already name it (`<subject>`,
 * `agent:<id>`, `code-project:<id>`, `chat-project:<id>`, `system`); at
 * most one sandbox that is not `deleted` exists for a key, which is what
 * makes two processes provisioning at once agree. `provider_id` is the
 * provider's own name for the machine, null until it has answered.
 * `address` is where the sandbox's worker is reached while it runs.
 * `last_active_at` is the last call made for the scope: what the idle
 * rules read. `state_changed_at` is what finds a transition whose
 * orchestrator died half way. A `deleted` row is kept for a while as the
 * record of what was removed and why (`error`), then purged.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE sandboxes (
      id               UUID PRIMARY KEY,
      route_key        TEXT NOT NULL,
      kind             TEXT NOT NULL
        CHECK (kind IN ('user', 'agent', 'project', 'system')),
      provider         TEXT NOT NULL,
      provider_id      TEXT,
      state            TEXT NOT NULL
        CHECK (state IN ('provisioning', 'running', 'suspending', 'suspended',
                         'resuming', 'deleting', 'deleted')),
      address          TEXT,
      error            TEXT,
      created_at       TIMESTAMPTZ NOT NULL,
      last_active_at   TIMESTAMPTZ NOT NULL,
      state_changed_at TIMESTAMPTZ NOT NULL,
      verified_at      TIMESTAMPTZ NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX sandboxes_live_route_key_idx ON sandboxes (route_key)
      WHERE state <> 'deleted'
  `.execute(db);
  await sql`
    CREATE INDEX sandboxes_state_idx ON sandboxes (state, last_active_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS sandboxes`.execute(db);
}
