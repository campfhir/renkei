import { Kysely, sql } from 'kysely';

/**
 * Upload slots: the out-of-band byte path that replaced every contentBase64
 * tool parameter. An MCP tool argument is text the CALLING MODEL must
 * generate — megabytes of base64 is hundreds of thousands of output tokens,
 * which reads as the tool "hanging" while the request never even reaches the
 * server. So a *_request_*_upload tool mints one of these rows and hands
 * back a short-lived endpoint; the bytes are POSTed to it directly (curl, or
 * the built-in browser page) with the opaque bearer token in the
 * Authorization header, and the route forwards them to the destination
 * (Jira issue, JSM request, Confluence page, OneDrive/SharePoint folder,
 * Outlook draft) under the requesting user's own stored grants.
 *
 * `token_hash` is sha256 of the bearer; the token itself is never stored.
 * The POST claims a slot with one conditional UPDATE (pending + unexpired +
 * matching hash), which is also what makes it single-use. `subject` scopes
 * the check_file_upload status tool, exactly like mail_bulk_jobs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('upload_slots')
    // The slot id appears in the URL and is deliberately NON-secret; the
    // Authorization bearer is the credential.
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('token_hash', 'varchar(64)', (col) => col.notNull().unique())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // The provider account whose grant the upload acts under.
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    // 'jira-attachment' | 'jsm-attachment' | 'confluence-attachment' |
    // 'onedrive-document' | 'sharepoint-document' | 'outlook-draft-attachment'
    .addColumn('kind', 'varchar(32)', (col) => col.notNull())
    // Per kind: {issueKey} / {requestKey} / {contentId, comment?} /
    // {driveId, parentItemId, ifNameTaken?} / {draftId}
    .addColumn('destination', 'jsonb', (col) => col.notNull())
    .addColumn('filename', 'varchar(255)', (col) => col.notNull())
    .addColumn('content_type', 'varchar(255)')
    .addColumn('max_bytes', 'integer', (col) => col.notNull())
    // 'pending' | 'completed' | 'failed' | 'expired'
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('result', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('completed_at', 'timestamptz')
    .execute();

  // The pruning sweep walks by expiry.
  await db.schema.createIndex('idx_upload_slots_expiry').on('upload_slots').column('expires_at').execute();

  // check_file_upload's listing shape (and its tenant+subject scope).
  await db.schema
    .createIndex('idx_upload_slots_owner_time')
    .on('upload_slots')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('upload_slots').execute();
}
