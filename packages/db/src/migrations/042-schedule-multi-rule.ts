import { Kysely, sql } from 'kysely';

/**
 * Schedule triggers grow from one recurrence to a rule LIST (union,
 * earliest wins). The config shape moves from `{recurrence, timezone}` to
 * `{recurrences: [...], timezone, startAt?, calendarId?, blackouts?,
 * blackoutPolicy?}` — data-only, no schema change: config is already
 * jsonb, and the due-scan partial index on next_run_at is untouched.
 *
 * The code's parseScheduleConfig keeps a legacy fallback for the old
 * single-`recurrence` shape, so a replica sweeping in the window between
 * deploy and this migration still fires correctly; this migration just
 * ends that window by normalizing every stored row to one shape.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE agent_triggers
    SET config = (config - 'recurrence')
      || jsonb_build_object('recurrences', jsonb_build_array(config -> 'recurrence'))
    WHERE kind = 'schedule' AND config ? 'recurrence' AND NOT config ? 'recurrences'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Lossy for multi-rule rows by necessity: the old shape holds one rule,
  // so only single-element lists convert back; anything else keeps the new
  // shape (and old code drops it as malformed rather than misfiring).
  await sql`
    UPDATE agent_triggers
    SET config = (config - 'recurrences')
      || jsonb_build_object('recurrence', config -> 'recurrences' -> 0)
    WHERE kind = 'schedule'
      AND config ? 'recurrences'
      AND jsonb_array_length(config -> 'recurrences') = 1
  `.execute(db);
}
