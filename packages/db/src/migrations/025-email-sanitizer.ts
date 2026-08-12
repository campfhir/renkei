import { Kysely, sql } from 'kysely';

/**
 * The email sanitizer's storage (see packages/email-sanitizer): three tables
 * split strictly by whether they carry message content, because that split
 * is the privacy boundary the feature is built around.
 *
 * `email_classifier_rules` and `email_extraction_templates` are content-free
 * by construction — a rule is a sender/domain/subject pattern, a template's
 * `spec` is boilerplate text plus field names, never a captured value — so
 * an org-admin route may read and write both directly.
 *
 * `email_classification_log` is the one table that carries content (a
 * bounded excerpt) and is scoped by `owner_upn`: every application read of
 * this table must filter to the caller's own resolved identity. There is no
 * admin surface over this table — see packages/email-sanitizer/src/persistence/log.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('email_classifier_rules')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('category', 'varchar(32)', (col) => col.notNull())
    .addColumn('match_type', 'varchar(32)', (col) => col.notNull())
    .addColumn('match_value', 'varchar(255)', (col) => col.notNull())
    // Names the extraction-template family for 'system_notification' rules; null otherwise.
    .addColumn('sender_key', 'varchar(64)')
    .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(100))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_email_classifier_rules_tenant_priority')
    .on('email_classifier_rules')
    .columns(['tenant_id', 'priority'])
    .execute();

  await db.schema
    .createTable('email_extraction_templates')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('sender_key', 'varchar(64)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    // TemplateSegment[] — fixed wrapper text plus field names, never a captured value.
    .addColumn('spec', 'jsonb', (col) => col.notNull())
    .addColumn('match_threshold', 'real', (col) => col.notNull().defaultTo(0.85))
    // Audit only: who taught this version, from their own message.
    .addColumn('derived_by_upn', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('superseded_at', 'timestamp')
    .execute();

  // One active version per sender at a time; superseded versions are kept for audit.
  await db.schema
    .createIndex('idx_email_extraction_templates_active')
    .unique()
    .on('email_extraction_templates')
    .columns(['tenant_id', 'sender_key'])
    .where(sql.ref('status'), '=', 'active')
    .execute();

  await db.schema
    .createTable('email_classification_log')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('provider', 'varchar(64)', (col) => col.notNull())
    .addColumn('ref_id', 'varchar(255)', (col) => col.notNull())
    // The ONLY visibility scope: every application read filters this against the caller's own identity.
    .addColumn('owner_upn', 'varchar(255)', (col) => col.notNull())
    // The connector account/grant id for this owner (mirrors webhook_subscriptions.account_id) —
    // recorded so an owner's override can re-resolve access without a reverse lookup by identity.
    .addColumn('account_id', 'varchar(255)')
    .addColumn('category', 'varchar(32)', (col) => col.notNull())
    .addColumn('matched_rule_id', 'uuid')
    .addColumn('sender_key', 'varchar(64)')
    .addColumn('template_id', 'uuid')
    .addColumn('template_version', 'integer')
    .addColumn('match_score', 'real')
    .addColumn('content_hash', 'varchar(64)')
    .addColumn('needs_review', 'boolean', (col) => col.notNull().defaultTo(false))
    // Bounded, owner-visible-only excerpt (subject/from/snippet) — never the full body.
    .addColumn('excerpt', 'text', (col) => col.notNull())
    .addColumn('override_action', 'varchar(16)')
    .addColumn('override_category', 'varchar(32)')
    .addColumn('override_sender_key', 'varchar(64)')
    .addColumn('overridden_at', 'timestamp')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // Re-processing (delta re-sync, an owner's override) replaces, not duplicates.
  await db.schema
    .createIndex('idx_email_classification_log_ref')
    .unique()
    .on('email_classification_log')
    .columns(['tenant_id', 'provider', 'ref_id'])
    .execute();

  // The owner's own review page: recent-first, scoped to their identity.
  await db.schema
    .createIndex('idx_email_classification_log_owner')
    .on('email_classification_log')
    .columns(['tenant_id', 'owner_upn', 'created_at'])
    .execute();

  // Exact-hash dedup lookback.
  await db.schema
    .createIndex('idx_email_classification_log_content_hash')
    .on('email_classification_log')
    .columns(['tenant_id', 'content_hash'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('email_classification_log').execute();
  await db.schema.dropTable('email_extraction_templates').execute();
  await db.schema.dropTable('email_classifier_rules').execute();
}
