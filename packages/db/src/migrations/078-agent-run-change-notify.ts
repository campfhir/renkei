import { Kysely, sql } from 'kysely';

/**
 * NOTIFY on every write that can change what the run detail page shows: the
 * run row itself, one of its step attempts, or the approval/question card
 * that pauses it — the one thing the run page's live stream needs to know
 * ("run X just changed, go re-read it").
 *
 * Triggers rather than an application-code call: a run is written from more
 * than one place (the engine's per-step checkpoint, the cancellation path,
 * a rerun's insert, the approval/question decision routes), and a NOTIFY
 * that depended on every writer remembering to emit it would eventually
 * miss one. The payload is just the run id — well under Postgres's
 * 8000-byte NOTIFY limit no matter how big steps_snapshot or detail get —
 * and the listener already knows how to fetch a run's current, correctly
 * redacted view by id.
 *
 * NOTIFY only fires on COMMIT and only reaches sessions LISTENing at that
 * moment (no queueing, no replay) — exactly what a live view needs and
 * nothing more durable than that.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // NEW only — OLD is unassigned on INSERT (and referencing a field of it
  // throws "record 'old' is not assigned yet"), and this trigger never
  // fires on DELETE, so OLD is never actually available to fall back to.
  await sql`
    CREATE OR REPLACE FUNCTION notify_agent_run_change() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('agent_run_change', NEW.id::text);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER agent_runs_notify_change
    AFTER INSERT OR UPDATE ON agent_runs
    FOR EACH ROW EXECUTE FUNCTION notify_agent_run_change()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION notify_agent_run_step_change() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('agent_run_change', NEW.run_id::text);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER agent_run_steps_notify_change
    AFTER INSERT OR UPDATE ON agent_run_steps
    FOR EACH ROW EXECUTE FUNCTION notify_agent_run_step_change()
  `.execute(db);

  // actionable_items is where a run's approval/question pause card lives —
  // it appearing, being decided, or being resolved by the timeout sweep is
  // as much a "redraw the run page" event as the run row changing status.
  // Only rows linked to a run (run_id not null) are worth a run-page
  // refresh; the curated-card feed's own items fire this for nothing.
  await sql`
    CREATE OR REPLACE FUNCTION notify_agent_run_via_actionable_item() RETURNS trigger AS $$
    BEGIN
      IF NEW.run_id IS NOT NULL THEN
        PERFORM pg_notify('agent_run_change', NEW.run_id::text);
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER actionable_items_notify_run_change
    AFTER INSERT OR UPDATE ON actionable_items
    FOR EACH ROW EXECUTE FUNCTION notify_agent_run_via_actionable_item()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS actionable_items_notify_run_change ON actionable_items`.execute(
    db
  );
  await sql`DROP FUNCTION IF EXISTS notify_agent_run_via_actionable_item()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS agent_run_steps_notify_change ON agent_run_steps`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_agent_run_step_change()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS agent_runs_notify_change ON agent_runs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_agent_run_change()`.execute(db);
}
