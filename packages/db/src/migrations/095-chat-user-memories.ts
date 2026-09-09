import { Kysely, sql } from 'kysely';

/**
 * `chat_user_memories` — the same shape as `chat_project_memories` (092),
 * scoped to a person rather than a project: append-only entries plus one
 * rolling summary, rendered under a read-time budget. Unlike project
 * memory, every chat the person owns writes and reads the same rows —
 * except a chat inside a project, which sees only its project's memory
 * and never this table, keeping a project's context self-contained. The
 * originating chat is kept per entry so a person can trace a note back to
 * where it was said; there is no `author_subject` because there is only
 * ever one author, the row's owner.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_user_memories')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('kind', 'varchar(16)', (col) => col.notNull().defaultTo('entry'))
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('chat_id', 'uuid', (col) => col.references('chats.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_chat_user_memories_owner')
    .on('chat_user_memories')
    .columns(['tenant_id', 'owner_subject', 'kind', 'created_at'])
    .execute();
  await sql`
    CREATE UNIQUE INDEX chat_user_memories_summary
      ON chat_user_memories (tenant_id, owner_subject) WHERE kind = 'summary'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('chat_user_memories').execute();
}
