/**
 * Postgres access for sandbox browser secrets — the sealed blob and its
 * non-secret description (name, field names, host scope, expiry). Nothing
 * here can read a value: the blob is sealed under a passphrase-derived key
 * (packages/connector-sandbox/src/secrets.ts) that only the in-memory vault
 * (secret-vault.ts) ever holds. Every read and write is scoped by
 * (tenantId, subject), the same no-cross-caller discipline as sandbox_files.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

export interface SecretTarget {
  tenantId: string;
  subject: string;
}

export interface StoredSecret extends SecretTarget {
  id: string;
  name: string;
  fields: string[];
  hosts: string[];
  sealed: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

const COLUMNS = [
  'id',
  'tenant_id',
  'subject',
  'name',
  'field_names',
  'hosts',
  'sealed',
  'created_at',
  'expires_at',
  'last_used_at',
] as const;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function toStored(row: {
  id: string;
  tenant_id: string;
  subject: string;
  name: string;
  field_names: unknown;
  hosts: unknown;
  sealed: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
}): StoredSecret {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: row.subject,
    name: row.name,
    fields: strings(row.field_names),
    hosts: strings(row.hosts),
    sealed: row.sealed,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function insertSecret(
  db: Kysely<DB>,
  input: SecretTarget & {
    name: string;
    fields: string[];
    hosts: string[];
    sealed: string;
    expiresAt: Date;
  }
): Promise<StoredSecret> {
  const row = await db
    .insertInto('sandbox_secrets')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      subject: input.subject,
      name: input.name,
      field_names: JSON.stringify(input.fields),
      hosts: JSON.stringify(input.hosts),
      sealed: input.sealed,
      expires_at: input.expiresAt,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toStored(row);
}

export async function listSecrets(db: Kysely<DB>, target: SecretTarget): Promise<StoredSecret[]> {
  const rows = await db
    .selectFrom('sandbox_secrets')
    .select(COLUMNS)
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .orderBy('name')
    .execute();
  return rows.map(toStored);
}

export async function countSecrets(db: Kysely<DB>, target: SecretTarget): Promise<number> {
  const row = await db
    .selectFrom('sandbox_secrets')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .executeTakeFirst();
  return row?.count ? Number(row.count) : 0;
}

export async function getSecret(
  db: Kysely<DB>,
  target: SecretTarget,
  id: string
): Promise<StoredSecret | undefined> {
  const row = await db
    .selectFrom('sandbox_secrets')
    .select(COLUMNS)
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? toStored(row) : undefined;
}

export async function getSecretByName(
  db: Kysely<DB>,
  target: SecretTarget,
  name: string
): Promise<StoredSecret | undefined> {
  const row = await db
    .selectFrom('sandbox_secrets')
    .select(COLUMNS)
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('name', '=', name)
    .executeTakeFirst();
  return row ? toStored(row) : undefined;
}

export async function touchSecretUsed(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .updateTable('sandbox_secrets')
    .set({ last_used_at: new Date() })
    .where('id', '=', id)
    .execute();
}

/** Delete one of the caller's secrets; the row, or undefined when there was none. */
export async function deleteSecret(
  db: Kysely<DB>,
  target: SecretTarget,
  id: string
): Promise<{ id: string; name: string } | undefined> {
  const row = await db
    .deleteFrom('sandbox_secrets')
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('id', '=', id)
    .returning(['id', 'name'])
    .executeTakeFirst();
  return row ?? undefined;
}

/** Rows past their expiry — the sweep drops each one's key, then the row. */
export async function listExpiredSecrets(db: Kysely<DB>, limit: number): Promise<{ id: string }[]> {
  return db
    .selectFrom('sandbox_secrets')
    .select(['id'])
    .where('expires_at', '<', new Date())
    .limit(limit)
    .execute();
}

export async function deleteSecretById(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('sandbox_secrets').where('id', '=', id).execute();
}
