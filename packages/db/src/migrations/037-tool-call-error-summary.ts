import { Kysely } from 'kysely';

/**
 * A brief error summary on FAILED tool calls — a deliberate, narrow revision
 * of migration 032's "no message text" stance.
 *
 * 032's reasoning stands for successes: what a working call said is the
 * user's business and is still never recorded. But a failure with no message
 * anywhere is undiagnosable — the error text went back to the MCP client and
 * evaporated, so "it keeps failing" reaches the helpdesk with nothing
 * attached. The summary exists so the person who made the call can read what
 * went wrong and quote it when asking for help.
 *
 * Two properties keep this from re-opening what 032 closed:
 *  - Only failures carry it. The recording path writes NULL for status='ok',
 *    so a success cannot leak content here even by bug — there is no code
 *    path that stores a successful result.
 *  - It is shown only to the CALLER. The usage API projects it exclusively
 *    for rows whose subject is the requester; an operator's tenant-wide view
 *    gets times, durations and names, never the text. Error messages can
 *    quote inputs ("no library named X"), which is content, and content
 *    stays with its owner.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('tool_calls')
    // varchar rather than text: this is a summary, and the cap is enforced in
    // the schema so a pathological error body cannot bloat the hot table.
    .addColumn('error_summary', 'varchar(500)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tool_calls').dropColumn('error_summary').execute();
}
