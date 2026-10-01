import { Kysely, sql } from 'kysely';

/**
 * The image ledger: one row per picture an image generation model drew,
 * timestamped and attributed to a person — the voice ledger's (110) twin
 * for images, and content-free the same way: the prompt and the picture
 * are never stored, only how much. `image_bytes` is the file as kept (after
 * validation), `input_tokens` / `output_tokens` what the provider billed
 * when it said (gpt-image does; FLUX reports none and reads 0), and
 * `surface`, `provider` and `model` allow a breakdown by vendor later.
 *
 * Pruned with the other ledgers under the org's usage retention.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('image_usage')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // The wire dialect: 'images' (OpenAI Images API) or 'flux'.
    .addColumn('surface', 'varchar(16)', (col) => col.notNull())
    .addColumn('provider', 'varchar(32)')
    .addColumn('model', 'varchar(120)')
    .addColumn('images', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('image_bytes', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_image_usage_subject')
    .on('image_usage')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('image_usage').execute();
}
