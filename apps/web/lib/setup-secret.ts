/**
 * The one-time setup secret: what stands in for an operator session while a
 * deployment has no identity provider yet.
 *
 * Operator identity is itself derived from OIDC, so until the identity
 * provider is configured nobody can hold an operator session — and whoever
 * configures it first decides who becomes an operator. The first
 * configuration (POST api/oidc) therefore needs something only the person
 * running the deployment can have: a secret this module mints when the
 * setup page is first opened and writes to the server's log, where only
 * someone with access to the process or its log store can read it. Only the
 * digest is kept (in `settings`, like every other bearer credential here),
 * and the secret dies on use or after a day, whichever comes first.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { generateSecret, sha256Hex } from '@renkei/crypto';
import { digestsMatch } from '@/lib/mcp-token';
import { logger } from '@/lib/logger';

export { SETUP_SECRET_HEADER } from './setup-secret-header';
export const SETUP_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

const HASH_KEY = 'setup_secret_hash';
const EXPIRES_KEY = 'setup_secret_expires_at';

/** Whether this deployment has an identity provider: the thing setup exists to create. */
export async function identityProviderConfigured(db: Kysely<DB>): Promise<boolean> {
  const row = await db.selectFrom('oidc_config').select('client_id').executeTakeFirst();
  return Boolean(row);
}

interface StoredSecret {
  hash: string | null;
  expiresAt: Date | null;
}

async function storedSecret(db: Kysely<DB>): Promise<StoredSecret> {
  const rows = await db
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('key', 'in', [HASH_KEY, EXPIRES_KEY])
    .execute();
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const hash = byKey.get(HASH_KEY);
  const expires = byKey.get(EXPIRES_KEY);
  return {
    hash: typeof hash === 'string' ? hash : null,
    expiresAt: typeof expires === 'string' ? new Date(expires) : null,
  };
}

async function writeSetting(db: Kysely<DB>, key: string, value: string | null): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('settings')
    .values({ key, value: JSON.stringify(value), updated_at: now })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: now }))
    .execute();
}

export type SetupState = 'configured' | 'live' | 'minted';

/**
 * Make sure a live setup secret exists while setup is still needed. Minting
 * one writes it to the log — the only place it ever appears in the clear —
 * with the page it is for.
 */
export async function ensureSetupSecret(
  db: Kysely<DB>,
  setupUrl: string,
  now: Date = new Date()
): Promise<SetupState> {
  if (await identityProviderConfigured(db)) return 'configured';
  const current = await storedSecret(db);
  if (current.hash && current.expiresAt && current.expiresAt > now) return 'live';

  const secret = generateSecret(32);
  const expiresAt = new Date(now.getTime() + SETUP_SECRET_TTL_MS);
  await writeSetting(db, HASH_KEY, sha256Hex(secret));
  await writeSetting(db, EXPIRES_KEY, expiresAt.toISOString());
  const message =
    `First-run setup: this deployment has no identity provider yet. Open ${setupUrl} ` +
    `and enter the setup secret ${secret} (valid until ${expiresAt.toISOString()}).`;
  logger.warn(message, { component: 'auth/setup' });
  console.warn(`[renkei] ${message}`);
  return 'minted';
}

export type SetupVerdict = 'ok' | 'missing' | 'expired' | 'mismatch' | 'none-issued';

/** Whether a presented secret is the live one. */
export async function verifySetupSecret(
  db: Kysely<DB>,
  presented: string | null | undefined,
  now: Date = new Date()
): Promise<SetupVerdict> {
  const current = await storedSecret(db);
  if (!current.hash) return 'none-issued';
  if (!presented) return 'missing';
  if (!current.expiresAt || current.expiresAt < now) return 'expired';
  return digestsMatch(current.hash, sha256Hex(presented)) ? 'ok' : 'mismatch';
}

/** Spent: the secret was for exactly one write. */
export async function clearSetupSecret(db: Kysely<DB>): Promise<void> {
  await db.deleteFrom('settings').where('key', 'in', [HASH_KEY, EXPIRES_KEY]).execute();
}
