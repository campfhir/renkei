/**
 * Workspace environment secrets — the `sandbox_env_secrets` row: a
 * variable's name and its sealed value, through the data store
 * (`sandboxEnvSecrets`). Sealing and opening are env-secrets.ts's (this
 * worker's own key); nothing here reads a value. Every read and write is
 * scoped by subject.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type SandboxEnvSecretRecord } from '@renkei/db';

export interface EnvTarget {
  subject: string;
}

/** What a listing shows: the name and when — never the value. */
export type EnvSecretSummary = SandboxEnvSecretRecord;

const envSecrets = () => getDataStore().sandboxEnvSecrets;

/** Set a variable: a new row, or a new sealed value for the name the caller already holds. */
export async function upsertEnvSecret(
  input: EnvTarget & { name: string; sealed: string }
): Promise<EnvSecretSummary> {
  return envSecrets().upsert({
    id: randomUUID(),
    subject: input.subject,
    name: input.name,
    sealed: input.sealed,
    updatedAt: new Date(),
  });
}

export async function listEnvSecrets(target: EnvTarget): Promise<EnvSecretSummary[]> {
  return envSecrets().list(target.subject);
}

export async function countEnvSecrets(target: EnvTarget): Promise<number> {
  return envSecrets().count(target.subject);
}

export async function hasEnvSecret(target: EnvTarget, name: string): Promise<boolean> {
  return envSecrets().has(target.subject, name);
}

/** The sealed values, for the worker to open at exec time — the one read of `sealed`. */
export async function listSealedEnv(
  target: EnvTarget
): Promise<Array<{ id: string; name: string; sealed: string }>> {
  return envSecrets().listSealed(target.subject);
}

export async function touchEnvSecretsUsed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await envSecrets().touchUsed(ids, new Date());
}

export async function deleteEnvSecret(
  target: EnvTarget,
  name: string
): Promise<{ id: string; name: string } | undefined> {
  return (await envSecrets().delete(target.subject, name)) ?? undefined;
}
