import { Kysely, sql } from 'kysely';

/**
 * The chat: Renkei's own conversational surface, on the org's model roster.
 *
 * Shape, and why:
 *
 * - `chats` are private to their owner (structural `owner_subject`, like
 *   agents) and may sit inside a `chat_projects` row — a shared workspace
 *   of instructions, files and memory that every chat in it reads. A chat
 *   moved into a project gains the project's context on its next turn and
 *   loses nothing of its own history; `project_id` is the whole move.
 *
 * - A `chat_turns` row is one press of Send: the user's message, the
 *   model's reply, and every tool round-trip in between. It carries the
 *   liveness of the work (`status`, `updated_at` as a heartbeat the runner
 *   refreshes while streaming) so a stream can be resumed from the rows
 *   on any replica and a crashed process leaves a turn a janitor can mark
 *   `interrupted` rather than one that looks alive forever. The partial
 *   unique index is the concurrency rule: one running turn per chat, made
 *   true by the database rather than by a check that could race.
 *
 * - `chat_messages` hold content blocks (text, thinking, tool_use,
 *   tool_result, attachments) as one encrypted JSON document per message
 *   under the same `renc1` envelope as knowledge chunks: a conversation
 *   carries whatever a person pastes into it, and the knowledge layer made
 *   the content-at-rest call already. Titles stay plaintext so the sidebar
 *   can list and search them. `seq` orders a chat; `kind` says what the
 *   row is (the person's prompt, the model's reply, the tool results the
 *   runner fed back) without decrypting it; `status` tracks a reply that
 *   is still streaming. The model that wrote a reply is snapshotted on the
 *   row because thinking blocks are only replayable to the model that
 *   signed them — a switch mid-chat has to know which rows to strip.
 *
 * - `chat_attachments` are metadata only; bytes live in the org's object
 *   store under `blob_key` (built from ids, never from a filename). The
 *   text extracted at upload is kept (encrypted) so the model can read a
 *   document on providers that cannot page-render it, and so a project's
 *   files can be quoted without a round trip to the store.
 *
 * - `chat_project_memories` mirror `agent_memories` (044): append-only
 *   entries plus one rolling summary, rendered under a read-time budget.
 *   Any member's chat can write to a project's memory, so the author and
 *   the originating chat are recorded per entry.
 *
 * - `resource_access_grants` is the named-person sharing of
 *   `agent_access_grants` (064) generalized: one row per grantee per
 *   resource, a role, an optional expiry. It serves chats (read-only),
 *   projects and prompt libraries alike, which is why `resource_id` is
 *   polymorphic and carries no foreign key — deleting a resource deletes
 *   its grants in application code, and a sweep prunes orphans.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_projects')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('instructions', 'text')
    .addColumn('tool_config', 'jsonb')
    .addColumn('published_to_org', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_chat_projects_owner')
    .on('chat_projects')
    .columns(['tenant_id', 'owner_subject', 'updated_at desc'])
    .execute();
  await sql`
    CREATE INDEX idx_chat_projects_published
      ON chat_projects (tenant_id) WHERE published_to_org
  `.execute(db);

  await db.schema
    .createTable('chats')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('project_id', 'uuid', (col) =>
      col.references('chat_projects.id').onDelete('set null')
    )
    .addColumn('title', 'varchar(200)')
    .addColumn('llm_model_id', 'uuid', (col) =>
      col.references('llm_model_configs.id').onDelete('set null')
    )
    .addColumn('tool_config', 'jsonb')
    .addColumn('thinking_enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('last_message_at', 'timestamptz')
    .addColumn('archived_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_chats_owner')
    .on('chats')
    .columns(['tenant_id', 'owner_subject', 'updated_at desc'])
    .execute();
  await db.schema
    .createIndex('idx_chats_project')
    .on('chats')
    .columns(['tenant_id', 'project_id', 'updated_at desc'])
    .execute();

  await db.schema
    .createTable('chat_turns')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('running'))
    .addColumn('llm_model_id', 'uuid', (col) =>
      col.references('llm_model_configs.id').onDelete('set null')
    )
    .addColumn('thinking_budget', 'integer')
    .addColumn('iterations', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('cancel_requested_at', 'timestamptz')
    .addColumn('error', 'text')
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    .execute();
  // One running turn per chat, enforced where it cannot race.
  await sql`
    CREATE UNIQUE INDEX chat_turns_one_running
      ON chat_turns (chat_id) WHERE status = 'running'
  `.execute(db);
  // The janitor's scan: running turns whose heartbeat went stale.
  await sql`
    CREATE INDEX idx_chat_turns_running
      ON chat_turns (updated_at) WHERE status = 'running'
  `.execute(db);
  await db.schema
    .createIndex('idx_chat_turns_chat')
    .on('chat_turns')
    .columns(['chat_id', 'started_at desc'])
    .execute();

  await db.schema
    .createTable('chat_messages')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('turn_id', 'uuid', (col) => col.references('chat_turns.id').onDelete('set null'))
    .addColumn('seq', 'integer', (col) => col.notNull())
    .addColumn('role', 'varchar(16)', (col) => col.notNull())
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('complete'))
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('llm_model_id', 'uuid', (col) =>
      col.references('llm_model_configs.id').onDelete('set null')
    )
    .addColumn('provider', 'varchar(32)')
    .addColumn('model', 'varchar(200)')
    .addColumn('stop_reason', 'varchar(16)')
    .addColumn('usage', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('chat_messages_chat_seq', ['chat_id', 'seq'])
    .execute();
  await db.schema
    .createIndex('idx_chat_messages_turn')
    .on('chat_messages')
    .columns(['turn_id'])
    .execute();

  await db.schema
    .createTable('chat_attachments')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('chat_id', 'uuid', (col) => col.references('chats.id').onDelete('cascade'))
    .addColumn('project_id', 'uuid', (col) =>
      col.references('chat_projects.id').onDelete('cascade')
    )
    .addColumn('message_id', 'uuid', (col) =>
      col.references('chat_messages.id').onDelete('set null')
    )
    .addColumn('blob_key', 'varchar(255)', (col) => col.notNull())
    .addColumn('filename', 'varchar(255)', (col) => col.notNull())
    .addColumn('content_type', 'varchar(127)', (col) => col.notNull())
    .addColumn('size_bytes', 'bigint', (col) => col.notNull())
    .addColumn('extracted_text', 'text')
    .addColumn('extract_status', 'varchar(16)', (col) => col.notNull().defaultTo('none'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addCheckConstraint('chat_attachments_home', sql`chat_id IS NOT NULL OR project_id IS NOT NULL`)
    .execute();
  await db.schema
    .createIndex('idx_chat_attachments_chat')
    .on('chat_attachments')
    .columns(['chat_id'])
    .execute();
  await db.schema
    .createIndex('idx_chat_attachments_project')
    .on('chat_attachments')
    .columns(['project_id'])
    .execute();
  await db.schema
    .createIndex('idx_chat_attachments_owner')
    .on('chat_attachments')
    .columns(['tenant_id', 'owner_subject', 'created_at desc'])
    .execute();

  await db.schema
    .createTable('chat_project_memories')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('chat_projects.id').onDelete('cascade')
    )
    .addColumn('kind', 'varchar(16)', (col) => col.notNull().defaultTo('entry'))
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('author_subject', 'varchar(255)')
    .addColumn('chat_id', 'uuid', (col) => col.references('chats.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_chat_project_memories_project')
    .on('chat_project_memories')
    .columns(['tenant_id', 'project_id', 'kind', 'created_at'])
    .execute();
  await sql`
    CREATE UNIQUE INDEX chat_project_memories_summary
      ON chat_project_memories (project_id) WHERE kind = 'summary'
  `.execute(db);

  await db.schema
    .createTable('resource_access_grants')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('resource_kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('resource_id', 'uuid', (col) => col.notNull())
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('grantee_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('role', 'varchar(16)', (col) => col.notNull().defaultTo('viewer'))
    .addColumn('expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addCheckConstraint(
      'resource_access_grants_kind',
      sql`resource_kind IN ('chat', 'chat_project', 'prompt_library')`
    )
    .addCheckConstraint('resource_access_grants_role', sql`role IN ('viewer', 'editor')`)
    .execute();
  // One grant per person per resource — re-sharing updates the row.
  await sql`
    CREATE UNIQUE INDEX resource_access_grants_unique
      ON resource_access_grants (resource_kind, resource_id, grantee_subject)
  `.execute(db);
  // "Shared with me", per kind.
  await db.schema
    .createIndex('idx_resource_access_grants_grantee')
    .on('resource_access_grants')
    .columns(['tenant_id', 'grantee_subject', 'resource_kind'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('resource_access_grants').execute();
  await db.schema.dropTable('chat_project_memories').execute();
  await db.schema.dropTable('chat_attachments').execute();
  await db.schema.dropTable('chat_messages').execute();
  await db.schema.dropTable('chat_turns').execute();
  await db.schema.dropTable('chats').execute();
  await db.schema.dropTable('chat_projects').execute();
}
