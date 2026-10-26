import { Kysely, sql } from 'kysely';

/**
 * The document ledger: one row per piece of work the model or OCR did on a
 * file a person uploaded, attributed to that uploader — the image and voice
 * ledgers' twin for documents. `kind` is `ocr` (a read by the OCR connector,
 * counted in `pages`), `summary` (a digest of text the file already had) or
 * `describe` (a picture described by the model, with no text needed). Tokens
 * are what the model billed; a summary or description reports both, an OCR
 * read reports pages only.
 *
 * `artifact_id` carries no foreign key: a file that is deleted keeps its usage,
 * as the image and voice ledgers keep theirs. Pruned with the other ledgers
 * under the org's usage retention.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('document_usage')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('artifact_id', 'uuid')
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    .addColumn('pages', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await sql`
    ALTER TABLE document_usage
      ADD CONSTRAINT document_usage_kind CHECK (kind IN ('ocr', 'summary', 'describe'))
  `.execute(db);
  await db.schema
    .createIndex('idx_document_usage_subject')
    .on('document_usage')
    .columns(['subject', 'created_at'])
    .execute();
  await db.schema
    .createIndex('idx_document_usage_created')
    .on('document_usage')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('document_usage').execute();
}
