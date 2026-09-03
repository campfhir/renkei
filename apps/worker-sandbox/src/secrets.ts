/**
 * Where the store and the vault meet the browser: resolving a `secret`
 * reference in a type step into the value to type — or a refusal the
 * model can act on — without the value ever leaving this process.
 *
 * The refusals are the design: a secret is typed only when it exists for
 * THIS caller, is currently unlocked (the person supplied the passphrase
 * within its window), names a field it has, and the page the browser is
 * on belongs to a host the secret was scoped to. Each refusal says which,
 * because the model's only remedy is to tell the person.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  secretHostAllowed,
  type SandboxSecretSummary,
  type SecretRef,
} from '@renkei/connector-sandbox';
import { BrowserOpError, type BrowserTarget } from './browser';
import { getSecretByName, touchSecretUsed, type StoredSecret } from './secrets-store';
import type { SecretVault } from './secret-vault';

/** What the browser asks of the secrets subsystem. */
export type SecretResolver = (
  target: BrowserTarget,
  ref: SecretRef,
  pageHost: string
) => Promise<string>;

export function createSecretResolver(db: Kysely<DB>, vault: SecretVault): SecretResolver {
  return async (target, ref, pageHost) => {
    const secret = await getSecretByName(db, target, ref.name);
    if (!secret) {
      throw new BrowserOpError(
        'secret_unavailable',
        `No secret named "${ref.name}" — see sandbox_browser_list_secrets for what exists.`
      );
    }
    if (!secret.fields.includes(ref.field)) {
      throw new BrowserOpError(
        'secret_unavailable',
        `Secret "${ref.name}" has no field "${ref.field}" (it has: ${secret.fields.join(', ')}).`
      );
    }
    if (!secretHostAllowed(pageHost, secret.hosts)) {
      throw new BrowserOpError(
        'secret_unavailable',
        `Secret "${ref.name}" may only be typed on ${secret.hosts.join(', ')} — the page is on ${pageHost || 'no host'}.`
      );
    }
    const fields = vault.open(secret.id, secret.sealed);
    if (!fields) {
      throw new BrowserOpError(
        'secret_unavailable',
        `Secret "${ref.name}" is locked — its owner must unlock it from the Renkei connectors page.`
      );
    }
    const value = fields[ref.field];
    if (typeof value !== 'string' || !value) {
      throw new BrowserOpError(
        'secret_unavailable',
        `Secret "${ref.name}" has no value for "${ref.field}".`
      );
    }
    await touchSecretUsed(db, secret.id).catch(() => {});
    return value;
  };
}

/** A stored row as every listing describes it, with the vault's word on its lock state. */
export function secretSummary(secret: StoredSecret, vault: SecretVault): SandboxSecretSummary {
  return {
    id: secret.id,
    name: secret.name,
    fields: secret.fields,
    hosts: secret.hosts,
    createdAt: secret.createdAt,
    expiresAt: secret.expiresAt,
    lastUsedAt: secret.lastUsedAt,
    unlockedUntil: vault.unlockedUntil(secret.id),
  };
}
