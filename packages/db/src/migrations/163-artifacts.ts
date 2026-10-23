import { Kysely, sql } from 'kysely';

/**
 * Artifacts: a chat's attachments and a project's files become one kind
 * of thing — a file stored once, owned by the person who uploaded it or
 * whose chat produced it, and USED in places by reference
 * (docs/artifacts-design.md).
 *
 *   - `chat_attachments` is renamed `artifacts`. A row keeps its chat
 *     (`chat_id`, the chat it was uploaded to or produced in) but no
 *     longer a project column: a project holds an artifact through an
 *     `artifact_references` row, which also says how the project's chats
 *     use it — `always` (its text travels with every turn) or
 *     `on_demand` (the model searches and reads it). The same artifact
 *     may be referenced by any number of projects without a second copy.
 *   - `key_kind`/`key_ref` say which key seals a row's extracted text.
 *     A row from before this migration stays under the key of where it
 *     lived — its chat's or its project's — and is re-sealed under a key
 *     of its own (`artifact`) the first time it is shared or attached
 *     anywhere else; a new row gets its own key from the start unless it
 *     is a plain chat upload, which stays under the chat's key as before.
 *   - `artifact` joins the resource kinds of `resource_access_grants`
 *     (a person it is shared with) and of `resource_keys`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chat_attachments RENAME TO artifacts`.execute(db);
  await sql`ALTER TABLE artifacts RENAME CONSTRAINT chat_attachments_origin TO artifacts_origin`.execute(
    db
  );
  await sql`ALTER TABLE artifacts DROP CONSTRAINT chat_attachments_home`.execute(db);
  await sql`ALTER INDEX idx_chat_attachments_chat RENAME TO idx_artifacts_chat`.execute(db);
  await sql`ALTER INDEX idx_chat_attachments_owner RENAME TO idx_artifacts_owner`.execute(db);
  await sql`ALTER INDEX idx_chat_attachments_artifacts RENAME TO idx_artifacts_model`.execute(db);

  await db.schema
    .alterTable('artifacts')
    .addColumn('key_kind', 'varchar(16)', (col) => col.notNull().defaultTo('artifact'))
    .addColumn('key_ref', 'uuid')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await sql`
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_key_kind CHECK (key_kind IN ('artifact', 'chat', 'chat_project'))
  `.execute(db);
  // Rows from before keep the key of where they lived.
  await sql`UPDATE artifacts SET key_kind = 'chat', key_ref = chat_id WHERE chat_id IS NOT NULL`.execute(
    db
  );
  await sql`
    UPDATE artifacts SET key_kind = 'chat_project', key_ref = project_id
     WHERE chat_id IS NULL AND project_id IS NOT NULL
  `.execute(db);

  await db.schema
    .createTable('artifact_references')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('artifact_id', 'uuid', (col) =>
      col.notNull().references('artifacts.id').onDelete('cascade')
    )
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('chat_projects.id').onDelete('cascade')
    )
    .addColumn('mode', 'varchar(16)', (col) => col.notNull().defaultTo('on_demand'))
    .addColumn('added_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addCheckConstraint('artifact_references_mode', sql`mode IN ('always', 'on_demand')`)
    .execute();
  await sql`
    CREATE UNIQUE INDEX artifact_references_unique
      ON artifact_references (artifact_id, project_id)
  `.execute(db);
  await db.schema
    .createIndex('idx_artifact_references_project')
    .on('artifact_references')
    .columns(['project_id', 'created_at'])
    .execute();
  // A project's files become that project's references to them.
  await sql`
    INSERT INTO artifact_references (artifact_id, project_id, mode, added_by, created_at)
    SELECT id, project_id, 'on_demand', owner_subject, created_at
      FROM artifacts WHERE project_id IS NOT NULL
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_chat_attachments_project`.execute(db);
  await sql`ALTER TABLE artifacts DROP COLUMN project_id`.execute(db);

  await sql`ALTER TABLE resource_access_grants DROP CONSTRAINT resource_access_grants_kind`.execute(
    db
  );
  await sql`
    ALTER TABLE resource_access_grants
      ADD CONSTRAINT resource_access_grants_kind
        CHECK (resource_kind IN ('chat', 'chat_project', 'prompt_library', 'artifact'))
  `.execute(db);
  await sql`ALTER TABLE resource_keys DROP CONSTRAINT resource_keys_kind`.execute(db);
  await sql`
    ALTER TABLE resource_keys
      ADD CONSTRAINT resource_keys_kind
        CHECK (resource_kind IN ('chat', 'chat_project', 'prompt_library', 'artifact'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM resource_access_grants WHERE resource_kind = 'artifact'`.execute(db);
  await sql`DELETE FROM resource_keys WHERE resource_kind = 'artifact'`.execute(db);
  await sql`ALTER TABLE resource_keys DROP CONSTRAINT resource_keys_kind`.execute(db);
  await sql`
    ALTER TABLE resource_keys
      ADD CONSTRAINT resource_keys_kind
        CHECK (resource_kind IN ('chat', 'chat_project', 'prompt_library'))
  `.execute(db);
  await sql`ALTER TABLE resource_access_grants DROP CONSTRAINT resource_access_grants_kind`.execute(
    db
  );
  await sql`
    ALTER TABLE resource_access_grants
      ADD CONSTRAINT resource_access_grants_kind
        CHECK (resource_kind IN ('chat', 'chat_project', 'prompt_library'))
  `.execute(db);

  await sql`
    ALTER TABLE artifacts
      ADD COLUMN project_id uuid REFERENCES chat_projects(id) ON DELETE CASCADE
  `.execute(db);
  // The oldest reference is the project the file was uploaded to.
  await sql`
    UPDATE artifacts a SET project_id = r.project_id
      FROM (
        SELECT DISTINCT ON (artifact_id) artifact_id, project_id
          FROM artifact_references ORDER BY artifact_id, created_at ASC
      ) r
     WHERE r.artifact_id = a.id AND a.chat_id IS NULL
  `.execute(db);
  await sql`DELETE FROM artifacts WHERE chat_id IS NULL AND project_id IS NULL`.execute(db);
  await db.schema.dropTable('artifact_references').execute();
  await sql`CREATE INDEX idx_chat_attachments_project ON artifacts (project_id)`.execute(db);
  await sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_key_kind`.execute(db);
  await sql`ALTER TABLE artifacts DROP COLUMN key_kind, DROP COLUMN key_ref, DROP COLUMN updated_at`.execute(
    db
  );
  await sql`
    ALTER TABLE artifacts
      ADD CONSTRAINT chat_attachments_home CHECK (chat_id IS NOT NULL OR project_id IS NOT NULL)
  `.execute(db);
  await sql`ALTER INDEX idx_artifacts_model RENAME TO idx_chat_attachments_artifacts`.execute(db);
  await sql`ALTER INDEX idx_artifacts_owner RENAME TO idx_chat_attachments_owner`.execute(db);
  await sql`ALTER INDEX idx_artifacts_chat RENAME TO idx_chat_attachments_chat`.execute(db);
  await sql`ALTER TABLE artifacts RENAME CONSTRAINT artifacts_origin TO chat_attachments_origin`.execute(
    db
  );
  await sql`ALTER TABLE artifacts RENAME TO chat_attachments`.execute(db);
}
