import { Kysely, sql } from 'kysely';

/**
 * Per-person encryption keys and the key store behind shared chats
 * (docs/user-encryption-keys-design.md; the primitives are
 * packages/crypto/src/keys.ts, the row logic packages/user-keys).
 *
 * Until now everything a chat holds was sealed under ONE deployment key
 * (the `renc1` content envelope, 092): any process with the key opens any
 * chat, a person's data has no key of its own, and sharing a chat is only
 * an access-grant row. These three tables give each person a key and each
 * chat a key, and make a share a cryptographic act:
 *
 * - `user_encryption_keys` — one row per (tenant, subject): the random
 *   SALT a person's key-encryption key (KEK) is derived from. The KEK
 *   itself is never stored: it is HKDF(master, salt, tenant ‖ subject),
 *   recomputed on demand. `version` counts rotations — a new salt is a new
 *   KEK, and every wrapping made under the old one is rewrapped in the
 *   same transaction. Deleting the row leaves every wrapping for that
 *   person unopenable.
 *
 * - `resource_keys` — one data key (DEK) per resource; the chat ↔ key
 *   relationship. Only the identity lives here (which resource, when):
 *   the key bytes exist at rest solely wrapped, in the grants below.
 *   `resource_id` is polymorphic like `resource_access_grants` (092) and
 *   carries no foreign key — the application deletes a resource's key
 *   with the resource, and the chat sweep prunes orphans.
 *
 * - `resource_key_grants` — the DEK wrapped under one person's KEK, one
 *   row per person who may open the resource. The owner's row is written
 *   with the key; sharing adds a row (unwrap under the owner's KEK, wrap
 *   under the grantee's); unsharing deletes it. `kek_version` says which
 *   of the person's KEKs the wrapping is under, so a rotation can find
 *   what it must rewrap.
 *
 * Content sealed under a resource key carries the `renc2:<key id>:…`
 * envelope; `renc1` rows written before this stay readable under the
 * deployment key and are re-sealed by `pnpm --filter @renkei/user-keys
 * rekey-chats` or on their next write.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('user_encryption_keys')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // 32 random bytes, base64; the KEK is derived from it, never stored.
    .addColumn('salt', 'varchar(64)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('rotated_at', 'timestamptz')
    .addPrimaryKeyConstraint('user_encryption_keys_pk', ['tenant_id', 'subject'])
    .execute();

  await db.schema
    .createTable('resource_keys')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('resource_kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('resource_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addCheckConstraint(
      'resource_keys_kind',
      sql`resource_kind IN ('chat', 'chat_project', 'prompt_library')`
    )
    .execute();
  // One key per resource — the chat ↔ key relationship.
  await sql`
    CREATE UNIQUE INDEX resource_keys_resource
      ON resource_keys (resource_kind, resource_id)
  `.execute(db);
  await db.schema
    .createIndex('idx_resource_keys_tenant')
    .on('resource_keys')
    .columns(['tenant_id'])
    .execute();

  await db.schema
    .createTable('resource_key_grants')
    .addColumn('resource_key_id', 'uuid', (col) =>
      col.notNull().references('resource_keys.id').onDelete('cascade')
    )
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // The data key, secretbox-wrapped under this person's KEK.
    .addColumn('wrapped_key', 'text', (col) => col.notNull())
    .addColumn('kek_version', 'integer', (col) => col.notNull())
    // Who made this wrapping: the owner (sharing), or null for the owner's own.
    .addColumn('granted_by', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('resource_key_grants_pk', ['resource_key_id', 'subject'])
    .execute();
  // "Every key this person holds" — the rotation's and the batch opener's scan.
  await db.schema
    .createIndex('idx_resource_key_grants_subject')
    .on('resource_key_grants')
    .columns(['tenant_id', 'subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('resource_key_grants').execute();
  await db.schema.dropTable('resource_keys').execute();
  await db.schema.dropTable('user_encryption_keys').execute();
}
