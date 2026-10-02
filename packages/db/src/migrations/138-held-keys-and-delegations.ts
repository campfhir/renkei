import { Kysely, sql } from 'kysely';

/**
 * Keys the person holds, and the delegations that let the delegate act
 * with them (docs/delegate-key-design.md, phases 2–5).
 *
 * Until now a person's key-encryption key was DERIVED — from a master the
 * delegate held (`managed`) or from a passphrase (`own`). From here it is
 * HELD: thirty-two random bytes the browser generates at enrollment, shows
 * once, keeps on the device, and never sends anywhere in the clear. The
 * server stores only what that key wraps and what is sealed to a
 * delegate's public key:
 *
 * - `user_encryption_keys` gains the `held` mode and, for it, the person's
 *   X25519 PUBLIC key (sharing wraps a resource key to it), their PRIVATE
 *   key wrapped under the user key, and their AUTOMATION key wrapped under
 *   the user key — the second symmetric key a person delegates for
 *   background work, so a delegate acting unattended holds their
 *   credentials and agent chats for the window and nothing else. The
 *   `salt`, `verifier`, `sealed_kek`, `unlocked_until` columns of the
 *   derived modes stay until every person has enrolled; `enroll` reads
 *   them one last time.
 *
 * - `delegate_instances` — each running delegate's id and the public key
 *   it generated at boot (its private half never leaves its memory), with
 *   a heartbeat so the browser seals only to instances that are alive.
 *
 * - `key_delegations` — a user key (scope `session`, bound to the browser
 *   session it lives and dies with) or an automation key (scope
 *   `automation`, with the expiry the person chose) sealed to one
 *   instance's public key. A delegate finds the row for itself, opens it,
 *   does the work, and drops the key; the session's deletion and the
 *   person's shred cascade through here.
 *
 * - `resource_key_grants` learns WHAT a wrapping is under: the person's
 *   `user` key, their `automation` key, their `public` key (a sealed box,
 *   the form sharing writes), or another `resource` key (a chat's key
 *   under its project's, so any member of the project opens it). The
 *   `subject` column becomes `holder`: a subject for the first three, a
 *   resource key id for the last. Every existing row is a `user` wrapping.
 *
 * - `device_key_requests` — a new browser's ask for the person's user key:
 *   its ephemeral public key and a short code; an enrolled device answers
 *   by sealing the key to that public key. Short-lived, no key in the
 *   clear at any point.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE user_encryption_keys DROP CONSTRAINT user_encryption_keys_mode`.execute(db);
  await sql`
    ALTER TABLE user_encryption_keys
      ADD CONSTRAINT user_encryption_keys_mode CHECK (mode IN ('managed', 'own', 'held'))
  `.execute(db);
  await db.schema.alterTable('user_encryption_keys').addColumn('public_key', 'text').execute();
  await db.schema
    .alterTable('user_encryption_keys')
    .addColumn('wrapped_private_key', 'text')
    .execute();
  await db.schema
    .alterTable('user_encryption_keys')
    .addColumn('wrapped_automation_key', 'text')
    .execute();
  await db.schema
    .alterTable('user_encryption_keys')
    .addColumn('enrolled_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('delegate_instances')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('public_key', 'text', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('heartbeat_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createTable('key_delegations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) => col.notNull())
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('instance_id', 'uuid', (col) =>
      col.notNull().references('delegate_instances.id').onDelete('cascade')
    )
    .addColumn('scope', 'varchar(16)', (col) => col.notNull())
    .addColumn('session_id', 'uuid', (col) => col.references('sessions.id').onDelete('cascade'))
    .addColumn('sealed_key', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addCheckConstraint('key_delegations_scope', sql`scope IN ('session', 'automation')`)
    .addForeignKeyConstraint(
      'key_delegations_person',
      ['tenant_id', 'subject'],
      'user_encryption_keys',
      ['tenant_id', 'subject'],
      (cb) => cb.onDelete('cascade')
    )
    .execute();
  await db.schema
    .createIndex('idx_key_delegations_person')
    .on('key_delegations')
    .columns(['tenant_id', 'subject'])
    .execute();
  await db.schema
    .createIndex('idx_key_delegations_expires')
    .on('key_delegations')
    .columns(['expires_at'])
    .execute();

  await db.schema
    .alterTable('resource_key_grants')
    .addColumn('holder_kind', 'varchar(16)', (col) => col.notNull().defaultTo('user'))
    .execute();
  await sql`ALTER TABLE resource_key_grants RENAME COLUMN subject TO holder`.execute(db);
  await sql`ALTER TABLE resource_key_grants DROP CONSTRAINT resource_key_grants_pk`.execute(db);
  await sql`
    ALTER TABLE resource_key_grants
      ADD CONSTRAINT resource_key_grants_pk PRIMARY KEY (resource_key_id, holder_kind, holder)
  `.execute(db);
  await sql`
    ALTER TABLE resource_key_grants
      ADD CONSTRAINT resource_key_grants_holder_kind
        CHECK (holder_kind IN ('user', 'automation', 'public', 'resource'))
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_resource_key_grants_subject`.execute(db);
  await db.schema
    .createIndex('idx_resource_key_grants_holder')
    .on('resource_key_grants')
    .columns(['tenant_id', 'holder'])
    .execute();

  await db.schema
    .createTable('device_key_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('public_key', 'text', (col) => col.notNull())
    .addColumn('code', 'varchar(8)', (col) => col.notNull())
    .addColumn('sealed_key', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('idx_device_key_requests_person')
    .on('device_key_requests')
    .columns(['tenant_id', 'subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('device_key_requests').execute();
  await db.schema.dropIndex('idx_resource_key_grants_holder').execute();
  await sql`ALTER TABLE resource_key_grants DROP CONSTRAINT resource_key_grants_holder_kind`.execute(
    db
  );
  await sql`DELETE FROM resource_key_grants WHERE holder_kind <> 'user'`.execute(db);
  await sql`ALTER TABLE resource_key_grants DROP CONSTRAINT resource_key_grants_pk`.execute(db);
  await sql`ALTER TABLE resource_key_grants RENAME COLUMN holder TO subject`.execute(db);
  await sql`
    ALTER TABLE resource_key_grants
      ADD CONSTRAINT resource_key_grants_pk PRIMARY KEY (resource_key_id, subject)
  `.execute(db);
  await db.schema.alterTable('resource_key_grants').dropColumn('holder_kind').execute();
  await db.schema
    .createIndex('idx_resource_key_grants_subject')
    .on('resource_key_grants')
    .columns(['tenant_id', 'subject'])
    .execute();
  await db.schema.dropTable('key_delegations').execute();
  await db.schema.dropTable('delegate_instances').execute();
  await db.schema.alterTable('user_encryption_keys').dropColumn('enrolled_at').execute();
  await db.schema
    .alterTable('user_encryption_keys')
    .dropColumn('wrapped_automation_key')
    .execute();
  await db.schema.alterTable('user_encryption_keys').dropColumn('wrapped_private_key').execute();
  await db.schema.alterTable('user_encryption_keys').dropColumn('public_key').execute();
  await sql`DELETE FROM user_encryption_keys WHERE mode = 'held'`.execute(db);
  await sql`ALTER TABLE user_encryption_keys DROP CONSTRAINT user_encryption_keys_mode`.execute(db);
  await sql`
    ALTER TABLE user_encryption_keys
      ADD CONSTRAINT user_encryption_keys_mode CHECK (mode IN ('managed', 'own'))
  `.execute(db);
}
