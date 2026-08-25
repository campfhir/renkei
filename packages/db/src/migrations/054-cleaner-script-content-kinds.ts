/**
 * Which content kinds a cleaner script is allowed to touch.
 *
 * Scripts were mail-only when they shipped, so the column did not exist and
 * the question never arose. Extending the stage to calendar invites and
 * tasks makes it urgent: a script written to cut a mail signature — "drop
 * everything after the last '--'" — would happily cut the back half of an
 * invite that happens to contain one. Silently widening an existing script's
 * reach is the kind of change that corrupts an index quietly and is noticed
 * weeks later.
 *
 * Hence the default: every row that already exists stays `{msg}`, exactly
 * as it behaves today. Reaching further is an explicit act by an admin who
 * has looked at the script and decided it generalises.
 *
 * A text[] rather than a boolean-per-kind: kinds are a growing list (drive
 * documents and chat messages are the obvious next ones) and adding to an
 * array is a data change, not another migration.
 */

import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('email_cleaner_scripts')
    .addColumn('applies_to', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY['msg']`))
    .execute();

  // An empty array would mean "runs on nothing", which is indistinguishable
  // from disabled but harder to see on the page — the enabled flag is where
  // that intent belongs.
  await sql`
    ALTER TABLE email_cleaner_scripts
    ADD CONSTRAINT email_cleaner_scripts_applies_to_not_empty
    CHECK (array_length(applies_to, 1) >= 1)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE email_cleaner_scripts
    DROP CONSTRAINT IF EXISTS email_cleaner_scripts_applies_to_not_empty
  `.execute(db);
  await db.schema.alterTable('email_cleaner_scripts').dropColumn('applies_to').execute();
}
