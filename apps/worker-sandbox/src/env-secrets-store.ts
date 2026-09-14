/**
 * Postgres access for workspace environment secrets — the `sandbox_env_secrets`
 * row: a variable's name and its sealed value. Sealing and opening are
 * env-secrets.ts's (this worker's own key); nothing here reads a value.
 * Every read and write is scoped by (tenantId, subject).
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

export interface EnvTarget {
  tenantId: string;
  subject: string;
}

/** What a listing shows: the name and when — never the value. */
export interface EnvSecretSummary {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

const SUMMARY_COLUMNS = ['id', 'name', 'created_at', 'updated_at', 'last_used_at'] as const;

function toSummary(row: {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}): EnvSecretSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Set a variable: a new row, or a new sealed value for the name the caller already holds. */
export async function upsertEnvSecret(
  db: Kysely<DB>,
  input: EnvTarget & { name: string; sealed: string }
): Promise<EnvSecretSummary> {
  const row = await db
    .insertInto('sandbox_env_secrets')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      subject: input.subject,
      name: input.name,
      sealed: input.sealed,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'subject', 'name']).doUpdateSet({
        sealed: input.sealed,
        updated_at: new Date(),
      })
    )
    .returning(SUMMARY_COLUMNS)
    .executeTakeFirstOrThrow();
  return toSummary(row);
}

export async function listEnvSecrets(
  db: Kysely<DB>,
  target: EnvTarget
): Promise<EnvSecretSummary[]> {
  const rows = await db
    .selectFrom('sandbox_env_secrets')
    .select(SUMMARY_COLUMNS)
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .orderBy('name')
    .execute();
  return rows.map(toSummary);
}

export async function countEnvSecrets(db: Kysely<DB>, target: EnvTarget): Promise<number> {
  const row = await db
    .selectFrom('sandbox_env_secrets')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .executeTakeFirst();
  return row?.count ? Number(row.count) : 0;
}

export async function hasEnvSecret(
  db: Kysely<DB>,
  target: EnvTarget,
  name: string
): Promise<boolean> {
  const row = await db
    .selectFrom('sandbox_env_secrets')
    .select('id')
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('name', '=', name)
    .executeTakeFirst();
  return row !== undefined;
}

/** The sealed values, for the worker to open at exec time — the one read of `sealed`. */
export async function listSealedEnv(
  db: Kysely<DB>,
  target: EnvTarget
): Promise<Array<{ id: string; name: string; sealed: string }>> {
  return db
    .selectFrom('sandbox_env_secrets')
    .select(['id', 'name', 'sealed'])
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .orderBy('name')
    .execute();
}

export async function touchEnvSecretsUsed(db: Kysely<DB>, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable('sandbox_env_secrets')
    .set({ last_used_at: new Date() })
    .where('id', 'in', ids)
    .execute();
}

export async function deleteEnvSecret(
  db: Kysely<DB>,
  target: EnvTarget,
  name: string
): Promise<{ id: string; name: string } | undefined> {
  const row = await db
    .deleteFrom('sandbox_env_secrets')
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('name', '=', name)
    .returning(['id', 'name'])
    .executeTakeFirst();
  return row ?? undefined;
}
