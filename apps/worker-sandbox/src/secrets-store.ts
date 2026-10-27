/**
 * Sandbox browser secrets — the sealed blob and its non-secret description
 * (name, field names, host scope, expiry), through the data store
 * (`sandboxSecrets`). Nothing here can read a value: the blob is sealed
 * under a passphrase-derived key (packages/connector-sandbox/src/secrets.ts)
 * that only the in-memory vault (secret-vault.ts) ever holds. Every read and
 * write is scoped by subject, the same no-cross-caller discipline as
 * sandbox_files.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type SandboxSecretRecord } from '@renkei/db';

export interface SecretTarget {
  subject: string;
}

export type StoredSecret = SandboxSecretRecord;

const secrets = () => getDataStore().sandboxSecrets;

export async function insertSecret(
  input: SecretTarget & {
    name: string;
    fields: string[];
    hosts: string[];
    sealed: string;
    expiresAt: Date;
  }
): Promise<StoredSecret> {
  return secrets().insert({
    id: randomUUID(),
    subject: input.subject,
    name: input.name,
    fields: input.fields,
    hosts: input.hosts,
    sealed: input.sealed,
    expiresAt: input.expiresAt,
  });
}

export async function listSecrets(target: SecretTarget): Promise<StoredSecret[]> {
  return secrets().list(target.subject);
}

export async function countSecrets(target: SecretTarget): Promise<number> {
  return secrets().count(target.subject);
}

export async function getSecret(
  target: SecretTarget,
  id: string
): Promise<StoredSecret | undefined> {
  return (await secrets().get(target.subject, id)) ?? undefined;
}

export async function getSecretByName(
  target: SecretTarget,
  name: string
): Promise<StoredSecret | undefined> {
  return (await secrets().getByName(target.subject, name)) ?? undefined;
}

export async function touchSecretUsed(id: string): Promise<void> {
  await secrets().touchUsed(id, new Date());
}

/** Delete one of the caller's secrets; the row, or undefined when there was none. */
export async function deleteSecret(
  target: SecretTarget,
  id: string
): Promise<{ id: string; name: string } | undefined> {
  return (await secrets().delete(target.subject, id)) ?? undefined;
}

/** Rows past their expiry — the sweep drops each one's key, then the row. */
export async function listExpiredSecrets(limit: number): Promise<{ id: string }[]> {
  return (await secrets().listExpiredIds(new Date(), limit)).map((id) => ({ id }));
}

export async function deleteSecretById(id: string): Promise<void> {
  await secrets().deleteById(id);
}
