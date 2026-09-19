import { Kysely, sql } from 'kysely';

/**
 * The voice ledger: one row per call to the speech service, timestamped
 * and attributed to a person — the token ledger's (085) twin for voice,
 * and content-free the same way: what was said or read is never stored,
 * only how much. `kind` says which way the sound went: `speech` is a
 * reply read aloud (text to speech, billed by the character —
 * `characters`), `transcription` is the person's own voice recognised
 * (speech to text, billed by the second — `audio_ms`). Both carry the
 * vendor, voice and language for a breakdown later.
 *
 * Pruned with the other ledgers under the org's usage retention.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('voice_usage')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // 'speech' (text → audio, a reply read) or 'transcription' (audio → text, the person heard).
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    .addColumn('characters', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('audio_ms', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('provider', 'varchar(32)')
    .addColumn('voice', 'varchar(120)')
    .addColumn('locale', 'varchar(16)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_voice_usage_subject')
    .on('voice_usage')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_voice_usage_kind')
    .on('voice_usage')
    .columns(['tenant_id', 'kind', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('voice_usage').execute();
}
