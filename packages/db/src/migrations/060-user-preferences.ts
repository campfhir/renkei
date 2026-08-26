import { Kysely, sql } from 'kysely';

/**
 * Per-person settings — the scope this schema was missing.
 *
 * Until now there were exactly two places a preference could live, and
 * neither generalizes. `identities` (migration 019) is deliberately narrow:
 * it records who someone is from their id_token claims and nothing else,
 * and widening it would blur recorded identity into stored opinion. And
 * `provider_grants.metadata` holds the Outlook indexing choice, which works
 * only because a Microsoft grant row exists to hang it on — there is
 * nowhere at all to put a preference for someone who has connected nothing.
 *
 * Meanwhile `nav.tsx` has carried a DISABLED "Preferences" menu item with
 * the comment "Placeholder until user preferences exist to edit." The slot
 * was cut and waiting.
 *
 * The shape is `tenant_settings` (migration 017) one scope level down: a
 * key/value table with JSON values, projected into a typed interface by an
 * accessor. That is deliberate — the org-settings accessor pattern
 * transfers verbatim, so nobody has to learn a second way to add a setting.
 *
 * Keyed by (tenant, subject) rather than by an identity FK: a preference
 * should survive an identity row being re-upserted at sign-in, and the
 * subject is the stable thing every other per-user table already keys on.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('user_preferences')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // A namespace, not a field: one row per area of the app ('notifications'),
    // so adding a preference is a field in a typed value rather than DDL.
    .addColumn('key', 'varchar(64)', (col) => col.notNull())
    .addColumn('value', 'jsonb', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('user_preferences_pkey', ['tenant_id', 'subject', 'key'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_preferences').execute();
}
