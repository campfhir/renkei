/**
 * Cleaner scripts may be written in TypeScript.
 *
 * QuickJS runs JavaScript, so the types have to come off somewhere. Doing
 * it at RUN time would mean transpiling once per script per message — a
 * mailbox sync would pay for the same transform thousands of times — so it
 * happens once, at save, and the result is stored here.
 *
 * `script` stays the source the admin wrote and reads back into the editor;
 * `compiled` is what the sandbox executes. Null means the two are the same,
 * which is true of every row written before this column existed, so nothing
 * needs backfilling and an older worker reading only `script` keeps working
 * on those rows.
 */

import { type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('email_cleaner_scripts').addColumn('compiled', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('email_cleaner_scripts').dropColumn('compiled').execute();
}
