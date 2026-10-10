/**
 * The setup secret: what stands in for an operator session while a
 * deployment has no identity provider yet.
 *
 * Operator identity is itself derived from OIDC, so until the identity
 * provider is configured nobody can hold an operator session — and whoever
 * configures it first decides who becomes an operator. The first
 * configuration (POST api/oidc) therefore needs something only the person
 * running the deployment can have. That is SETUP_SECRET in the app's
 * environment: the same place the database password and the encryption
 * keys live, set by whoever deploys and readable by nobody else. The
 * server never stores, logs or mints it; it compares a digest of what the
 * form presents against a digest of the variable, in constant time, and
 * once a provider exists the variable is ignored and can be removed.
 *
 * Why not the server log (where a minted secret used to go) or loopback
 * access: the log store is readable through the app's own log viewer, so a
 * secret written there outlives its purpose for as long as logs are kept;
 * and behind a reverse proxy the peer address is the proxy's, so "from
 * localhost" means either nobody or everybody. An environment variable is
 * a credential the operator already knows how to protect.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { sha256Hex } from '@renkei/crypto';
import { digestsMatch } from '@/lib/mcp-token';

export { SETUP_SECRET_HEADER } from './setup-secret-header';

/** The environment variable the secret is read from. */
export const SETUP_SECRET_ENV = 'SETUP_SECRET';
/** Fewer characters than this and the variable is refused as a secret. */
export const SETUP_SECRET_MIN_CHARS = 16;

/** Whether this deployment has an identity provider: the thing setup exists to create. */
export async function identityProviderConfigured(db: Kysely<DB>): Promise<boolean> {
  const row = await db.selectFrom('oidc_config').select('client_id').executeTakeFirst();
  return Boolean(row);
}

/** Why the environment holds no usable secret, or null when it does. */
export type SetupSecretProblem = 'unset' | 'short';

/** The shape of process.env, so a test can hand in exactly the variables it means. */
export type SetupEnv = Readonly<Record<string, string | undefined>>;

export function setupSecretProblem(env: SetupEnv = process.env): SetupSecretProblem | null {
  const value = env[SETUP_SECRET_ENV]?.trim() ?? '';
  if (value.length === 0) return 'unset';
  if (value.length < SETUP_SECRET_MIN_CHARS) return 'short';
  return null;
}

/** The usable secret, or null when none is set. */
function configuredSetupSecret(env: SetupEnv): string | null {
  if (setupSecretProblem(env) !== null) return null;
  return env[SETUP_SECRET_ENV]?.trim() ?? null;
}

/**
 * What the setup page shows: nothing (a provider exists), the form (a
 * usable secret is set), or how to set one.
 */
export type SetupState = 'configured' | 'ready' | SetupSecretProblem;

export async function setupState(db: Kysely<DB>, env: SetupEnv = process.env): Promise<SetupState> {
  if (await identityProviderConfigured(db)) return 'configured';
  return setupSecretProblem(env) ?? 'ready';
}

export type SetupVerdict = 'ok' | 'missing' | 'mismatch' | SetupSecretProblem;

/** Whether a presented secret is the configured one. */
export function verifySetupSecret(
  presented: string | null | undefined,
  env: SetupEnv = process.env
): SetupVerdict {
  const problem = setupSecretProblem(env);
  if (problem !== null) return problem;
  const configured = configuredSetupSecret(env);
  if (!configured) return 'unset';
  const value = presented?.trim() ?? '';
  if (value.length === 0) return 'missing';
  return digestsMatch(sha256Hex(configured), sha256Hex(value)) ? 'ok' : 'mismatch';
}
